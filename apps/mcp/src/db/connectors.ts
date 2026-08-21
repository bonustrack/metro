import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import {
  ConnectorVerifyError,
  parseConnectorUrl,
  verifyRemoteMcp,
  type ConnectorAuth,
  type OAuthAuth,
  type VerifiedRecord,
  type VerifiedServer,
} from '../daemon/connector-verify.js';
import { oauthExpired, refreshOAuth } from '../daemon/connector-oauth.js';
import { readStoredTools } from '../daemon/connector-tools.js';
import { newId } from './ids.js';
import { getDb } from './client.js';
import { ensureUser, isUniqueViolation, userIdForEmail } from './agent-admin.js';
import { connectors, type ConnectorTransport } from './schema.js';

const CONNECTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,4096}$/;
const DEFAULT_HEADER = 'Authorization';

class ConnectorError extends ApiError {}

export interface Connector {
  id: string;
  name: string;
  url: string;
  transport: ConnectorTransport;
  auth: ConnectorAuth['kind'];
  header: string | null;
  secret: string | null;
  verified: VerifiedRecord;
}

export interface ConnectorInput {
  name: unknown;
  url: unknown;
  header: unknown;
  value: unknown;
}

export type ConnectorCheck =
  | { id: string; name: string; ok: true; verified: VerifiedRecord }
  | { id: string; name: string; ok: false; reason: string };

export interface DeletedConnector {
  id: string;
  name: string;
}

interface ConnectorConfig {
  auth: ConnectorAuth;
  createdAt: string;
  verified: VerifiedRecord;
}

type ConnectorRow = typeof connectors.$inferSelect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function connectorName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!CONNECTOR_NAME_RE.test(name))
    throw new ConnectorError(
      'name must be 2-32 characters of A-Z, a-z, 0-9, - or _, starting with a letter or digit',
      400,
    );
  return name;
}

function connectorAuth(rawHeader: unknown, rawValue: unknown): ConnectorAuth {
  const header = text(rawHeader).trim();
  const value = text(rawValue).trim();
  if (header === '' && value === '') return { kind: 'none' };
  if (value === '')
    throw new ConnectorError(
      'that header has no value — give both a header name and its value, or neither',
      400,
    );
  const name = header === '' ? DEFAULT_HEADER : header;
  if (!HEADER_NAME_RE.test(name))
    throw new ConnectorError('that is not a valid HTTP header name', 400);
  if (!HEADER_VALUE_RE.test(value))
    throw new ConnectorError('that header value is not sendable', 400);
  return { kind: 'header', name, value };
}

function readOAuth(raw: Record<string, unknown>): ConnectorAuth {
  const accessToken = text(raw.accessToken);
  const clientId = text(raw.clientId);
  const tokenEndpoint = text(raw.tokenEndpoint);
  if (accessToken === '' || clientId === '' || tokenEndpoint === '')
    return { kind: 'none' };
  const refreshToken = text(raw.refreshToken);
  const clientSecret = text(raw.clientSecret);
  return {
    kind: 'oauth',
    accessToken,
    clientId,
    tokenEndpoint,
    issuer: text(raw.issuer),
    ...(refreshToken === '' ? {} : { refreshToken }),
    ...(clientSecret === '' ? {} : { clientSecret }),
    ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}),
  };
}

function readAuth(raw: unknown): ConnectorAuth {
  if (!isRecord(raw)) return { kind: 'none' };
  if (raw.kind === 'oauth') return readOAuth(raw);
  if (raw.kind !== 'header') return { kind: 'none' };
  const name = text(raw.name);
  const value = text(raw.value);
  if (name === '' || value === '') return { kind: 'none' };
  return { kind: 'header', name, value };
}

function readVerified(raw: unknown): VerifiedRecord {
  const record = isRecord(raw) ? raw : {};
  const catalog = readStoredTools(record.catalog);
  return {
    at: text(record.at),
    server: text(record.server),
    version: text(record.version),
    protocol: text(record.protocol),
    icon: text(record.icon),
    tools: typeof record.tools === 'number' ? record.tools : 0,
    catalog,
  };
}

function readConfig(raw: unknown): ConnectorConfig {
  const record = isRecord(raw) ? raw : {};
  return {
    auth: readAuth(record.auth),
    createdAt: text(record.createdAt),
    verified: readVerified(record.verified),
  };
}

function stamp(server: VerifiedServer): VerifiedRecord {
  return {
    at: new Date().toISOString(),
    server: server.server,
    version: server.version,
    protocol: server.protocol,
    icon: server.icon,
    tools: server.tools,
    catalog: server.catalog,
  };
}

function toConnector(row: ConnectorRow): Connector {
  const config = readConfig(row.config);
  const auth = config.auth;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    auth: auth.kind,
    header: auth.kind === 'header' ? auth.name : null,
    secret: auth.kind === 'header' ? auth.value : null,
    verified: config.verified,
  };
}

const missing = (): ConnectorError =>
  new ConnectorError('no such connector', 404);

async function ownedConnectorOrThrow(
  userId: string | null,
  id: string,
): Promise<ConnectorRow> {
  if (userId === null) throw missing();
  const rows = await getDb()
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, id), eq(connectors.userId, userId)));
  const row = rows[0];
  if (row === undefined) throw missing();
  return row;
}

export async function listConnectorsForEmail(
  email: string,
): Promise<Connector[]> {
  const userId = await userIdForEmail(email);
  if (userId === null) return [];
  const rows = await getDb()
    .select()
    .from(connectors)
    .where(eq(connectors.userId, userId))
    .orderBy(asc(connectors.id));
  return rows.map(toConnector);
}

export async function getConnectorForEmail(
  email: string,
  id: string,
): Promise<Connector> {
  const userId = await userIdForEmail(email);
  return toConnector(await ownedConnectorOrThrow(userId, id));
}

async function insertConnector(
  userId: string,
  name: string,
  url: URL,
  config: ConnectorConfig,
): Promise<Connector> {
  try {
    const rows = await getDb()
      .insert(connectors)
      .values({
        id: newId(),
        userId,
        name,
        url: url.toString(),
        transport: 'http',
        config,
      })
      .returning();
    const row = rows[0];
    if (row === undefined)
      throw new ConnectorError('connector insert returned no row', 500);
    return toConnector(row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new ConnectorError(
      `you already have a connector named '${name}'`,
      409,
    );
  }
}

export async function createConnectorForEmail(
  email: string,
  input: ConnectorInput,
): Promise<Connector> {
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const auth = connectorAuth(input.header, input.value);
  const userId = await ensureUser(email);
  const verified = stamp(await verifyRemoteMcp(url, auth));
  return insertConnector(userId, name, url, {
    auth,
    createdAt: new Date().toISOString(),
    verified,
  });
}

async function freshAuth(
  auth: ConnectorAuth,
  resource: string,
): Promise<ConnectorAuth> {
  if (auth.kind !== 'oauth' || !oauthExpired(auth)) return auth;
  return refreshOAuth(auth, resource);
}

export interface OAuthConnectorInput {
  name: string;
  url: string;
  auth: OAuthAuth;
}

export async function createOAuthConnectorForEmail(
  email: string,
  input: OAuthConnectorInput,
): Promise<Connector> {
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const userId = await ensureUser(email);
  const verified = stamp(await verifyRemoteMcp(url, input.auth));
  return insertConnector(userId, name, url, {
    auth: input.auth,
    createdAt: new Date().toISOString(),
    verified,
  });
}

export async function verifyConnectorForEmail(
  email: string,
  id: string,
): Promise<ConnectorCheck> {
  const userId = await userIdForEmail(email);
  const row = await ownedConnectorOrThrow(userId, id);
  const config = readConfig(row.config);
  try {
    const url = parseConnectorUrl(row.url);
    const auth = await freshAuth(config.auth, url.toString());
    const verified = stamp(await verifyRemoteMcp(url, auth));
    await getDb()
      .update(connectors)
      .set({ config: { ...config, auth, verified } })
      .where(and(eq(connectors.id, row.id), eq(connectors.userId, row.userId)));
    return { id: row.id, name: row.name, ok: true, verified };
  } catch (err) {
    if (!(err instanceof ConnectorVerifyError)) throw err;
    return { id: row.id, name: row.name, ok: false, reason: err.message };
  }
}

export async function deleteConnectorForEmail(
  email: string,
  id: string,
): Promise<DeletedConnector> {
  const userId = await userIdForEmail(email);
  if (userId === null) throw missing();
  const gone = await getDb()
    .delete(connectors)
    .where(and(eq(connectors.id, id), eq(connectors.userId, userId)))
    .returning({ id: connectors.id, name: connectors.name });
  const row = gone[0];
  if (row === undefined) throw missing();
  return row;
}
