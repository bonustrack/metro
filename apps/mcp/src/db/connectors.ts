import { assertRenameFreeOfClash } from './connector-collections.js';
import { projectIdOrThrow } from './projects.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
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
import { advertisesOAuth } from '../daemon/oauth-discovery.js';
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
  email: string,
  id: string,
): Promise<ConnectorRow> {
  const rows = await getDb()
    .select()
    .from(connectors)
    .where(eq(connectors.id, id));
  const row = rows[0];
  if (row === undefined) throw missing();
  try {
    await projectIdOrThrow(email, row.projectId);
  } catch {
    throw missing();
  }
  return row;
}

async function saveConfig(
  row: ConnectorRow,
  config: ConnectorConfig,
): Promise<Connector> {
  const rows = await getDb()
    .update(connectors)
    .set({ config })
    .where(and(eq(connectors.id, row.id), eq(connectors.projectId, row.projectId)))
    .returning();
  const saved = rows[0];
  if (saved === undefined) throw missing();
  return toConnector(saved);
}

async function connectorRowsFor(
  email: string,
  project: string,
): Promise<ConnectorRow[]> {
  const projectId = await projectIdOrThrow(email, project);
  return getDb()
    .select()
    .from(connectors)
    .where(eq(connectors.projectId, projectId))
    .orderBy(asc(connectors.id));
}

export async function listConnectorsForEmail(
  email: string,
  project: string,
): Promise<Connector[]> {
  return (await connectorRowsFor(email, project)).map(toConnector);
}

async function rowsByIds(ids: string[]): Promise<ConnectorRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(connectors)
    .where(inArray(connectors.id, ids))
    .orderBy(asc(connectors.id));
}

export async function connectorNamesByIds(
  ids: string[],
): Promise<{ id: string; name: string }[]> {
  return (await rowsByIds(ids)).map((row) => ({ id: row.id, name: row.name }));
}

export async function getConnectorForEmail(
  email: string,
  id: string,
): Promise<Connector> {
  return toConnector(await ownedConnectorOrThrow(email, id));
}

async function insertConnector(
  projectId: string,
  name: string,
  url: URL,
  config: ConnectorConfig,
): Promise<Connector> {
  const rows = await getDb()
    .insert(connectors)
    .values({
      id: newId(),
      projectId,
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
}

const UNVERIFIED = {
  at: '',
  server: '',
  version: '',
  protocol: '',
  icon: '',
  tools: 0,
  catalog: [],
};

export async function createPendingConnectorForEmail(
  email: string,
  project: string,
  input: { name: unknown; url: unknown },
): Promise<Connector> {
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const projectId = await projectIdOrThrow(email, project);
  return insertConnector(projectId, name, url, {
    auth: { kind: 'none' },
    createdAt: new Date().toISOString(),
    verified: UNVERIFIED,
    oauth: true,
  });
}

export async function createConnectorForEmail(
  email: string,
  project: string,
  input: ConnectorInput,
): Promise<Connector> {
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const auth = connectorAuth(input.header, input.value);
  const projectId = await projectIdOrThrow(email, project);
  const verified = stamp(await verifyRemoteMcp(url, auth));
  return insertConnector(projectId, name, url, {
    auth,
    createdAt: new Date().toISOString(),
    verified,
    oauth: await oauthCapable(url, auth),
  });
}

async function oauthCapable(url: URL, auth: ConnectorAuth): Promise<boolean> {
  if (auth.kind === 'oauth') return true;
  if (auth.kind === 'header') return false;
  return advertisesOAuth(url);
}

async function freshAuth(
  auth: ConnectorAuth,
  resource: string,
): Promise<ConnectorAuth> {
  if (auth.kind !== 'oauth' || !oauthExpired(auth)) return auth;
  return refreshOAuth(auth, resource);
}

export async function reconnectConnectorForEmail(
  email: string,
  id: string,
  auth: OAuthAuth,
): Promise<Connector> {
  const row = await ownedConnectorOrThrow(email, id);
  const config = readConfig(row.config);
  const url = parseConnectorUrl(row.url);
  const verified = stamp(await verifyRemoteMcp(url, auth));
  return saveConfig(row, { ...config, auth, verified, oauth: true });
}

export async function disconnectConnectorForEmail(
  email: string,
  id: string,
): Promise<Connector> {
  const row = await ownedConnectorOrThrow(email, id);
  const config = readConfig(row.config);
  if (config.auth.kind !== 'oauth')
    throw new ConnectorError('that connector is not signed in', 400);
  return saveConfig(row, { ...config, auth: { kind: 'none' }, oauth: true });
}

export async function verifyConnectorForEmail(
  email: string,
  id: string,
): Promise<ConnectorCheck> {
  const row = await ownedConnectorOrThrow(email, id);
  const config = readConfig(row.config);
  try {
    const url = parseConnectorUrl(row.url);
    const auth = await freshAuth(config.auth, url.toString());
    const verified = stamp(await verifyRemoteMcp(url, auth));
    const oauth = config.oauth || (await oauthCapable(url, auth));
    await saveConfig(row, { ...config, auth, verified, oauth });
    return { id: row.id, name: row.name, ok: true, verified };
  } catch (err) {
    if (!(err instanceof ConnectorVerifyError)) throw err;
    return { id: row.id, name: row.name, ok: false, reason: err.message };
  }
}

export async function renameConnectorForEmail(
  email: string,
  id: string,
  raw: string,
): Promise<Connector> {
  const name = connectorName(raw);
  const row = await ownedConnectorOrThrow(email, id);
  await assertRenameFreeOfClash(row.id, name);
  const rows = await getDb()
    .update(connectors)
    .set({ name })
    .where(and(eq(connectors.id, row.id), eq(connectors.projectId, row.projectId)))
    .returning();
  const saved = rows[0];
  if (saved === undefined) throw missing();
  return toConnector(saved);
}

export async function deleteConnectorForEmail(
  email: string,
  id: string,
): Promise<DeletedConnector> {
  const row = await ownedConnectorOrThrow(email, id);
  const gone = await getDb()
    .delete(connectors)
    .where(eq(connectors.id, row.id))
    .returning({ id: connectors.id, name: connectors.name });
  const deleted = gone[0];
  if (deleted === undefined) throw missing();
  return deleted;
}
