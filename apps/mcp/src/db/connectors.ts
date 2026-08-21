import { and, asc, eq } from 'drizzle-orm';
import {
  connectorUrlText,
  ConnectorVerifyError,
  parseConnectorUrl,
  verifyRemoteMcp,
  type ConnectorAuth,
  type OAuthAuth,
  type VerifiedRecord,
} from '../daemon/connector-verify.js';
import { oauthExpired, refreshOAuth } from '../daemon/connector-oauth.js';
import {
  ConnectorError,
  connectorAuth,
  connectorName,
  readConfig,
  signInState,
  stamp,
  type ConnectorConfig,
  type ConnectorSignIn,
} from './connector-config.js';
import { newId } from './ids.js';
import { getDb } from './client.js';
import { ensureUser, isUniqueViolation, userIdForEmail } from './agent-admin.js';
import { connectors, type ConnectorTransport } from './schema.js';

export interface Connector {
  id: string;
  name: string;
  url: string;
  transport: ConnectorTransport;
  auth: ConnectorAuth['kind'];
  header: string | null;
  secret: string | null;
  bearer: string | null;
  expiresAt: number | null;
  signIn: ConnectorSignIn;
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

type ConnectorRow = typeof connectors.$inferSelect;

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
    bearer: auth.kind === 'oauth' ? auth.accessToken : null,
    expiresAt: auth.kind === 'oauth' ? (auth.expiresAt ?? null) : null,
    signIn: signInState(config),
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

async function saveConfig(
  row: ConnectorRow,
  config: ConnectorConfig,
): Promise<Connector> {
  const rows = await getDb()
    .update(connectors)
    .set({ config })
    .where(and(eq(connectors.id, row.id), eq(connectors.userId, row.userId)))
    .returning();
  const saved = rows[0];
  if (saved === undefined) throw missing();
  return toConnector(saved);
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
        url: connectorUrlText(url),
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
    oauth: false,
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
    oauth: true,
  });
}

export async function reconnectConnectorForEmail(
  email: string,
  id: string,
  auth: OAuthAuth,
): Promise<Connector> {
  const userId = await userIdForEmail(email);
  const row = await ownedConnectorOrThrow(userId, id);
  const config = readConfig(row.config);
  const url = parseConnectorUrl(row.url);
  const verified = stamp(await verifyRemoteMcp(url, auth));
  return saveConfig(row, { ...config, auth, verified, oauth: true });
}

export async function disconnectConnectorForEmail(
  email: string,
  id: string,
): Promise<Connector> {
  const userId = await userIdForEmail(email);
  const row = await ownedConnectorOrThrow(userId, id);
  const config = readConfig(row.config);
  if (config.auth.kind !== 'oauth')
    throw new ConnectorError('that connector is not signed in', 400);
  return saveConfig(row, { ...config, auth: { kind: 'none' }, oauth: true });
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
    await saveConfig(row, { ...config, auth, verified });
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
