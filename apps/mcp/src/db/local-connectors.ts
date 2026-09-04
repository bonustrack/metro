import { join } from 'node:path';
import { readJson, writeSecure } from '../daemon/secure-fs.js';
import { errMsg, log } from '../daemon/log.js';
import {
  connectorUrlText,
  ConnectorVerifyError,
  parseConnectorUrl,
  verifyRemoteMcp,
  type ConnectorAuth,
  type OAuthAuth,
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
} from './connector-config.js';
import {
  bearerHeaders,
  fixedTarget,
  unrefreshedTarget,
  type RelayTarget,
} from './connector-relay.js';
import {
  connectorFromRow,
  UNVERIFIED,
  type Connector,
  type ConnectorCheck,
  type ConnectorInput,
  type ConnectorSummary,
  type DeletedConnector,
} from './connectors.js';
import type { AgentConnectors } from './agent-connectors.js';
import { agentsDir } from './file-source.js';
import {
  assertLocalOwner,
  connectorIdsOfLocalAgent,
  localAgentConnectorIds,
  localAgentsWith,
  localDropConnectorEverywhere,
  localOwnedAgentOrThrow,
  localSetAgentConnectors,
  LOCAL_PROJECT_ID,
} from './file-admin.js';
import { newId } from './ids.js';

export interface LocalConnectorRow {
  id: string;
  name: string;
  url: string;
  transport: 'http';
  config: ConnectorConfig;
}

const FILE = 'connectors.json';
const filePath = (dir: string): string => join(dir, FILE);

const isRow = (v: unknown): v is { id: string; name: string; url: string; config?: unknown } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { id?: unknown }).id === 'string' &&
  typeof (v as { name?: unknown }).name === 'string' &&
  typeof (v as { url?: unknown }).url === 'string';

const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.map((item: unknown) => item) : [];

export function readLocalConnectors(dir = agentsDir()): LocalConnectorRow[] {
  const raw = readJson<{ connectors?: unknown }>(filePath(dir), {}, {
    warn: 'connectors.json: malformed, ignoring',
  });
  return asList(raw.connectors).filter(isRow).map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    transport: 'http' as const,
    config: readConfig(r.config),
  }));
}

function writeRows(dir: string, rows: LocalConnectorRow[]): void {
  writeSecure(filePath(dir), `${JSON.stringify({ version: 1, connectors: rows }, null, 2)}\n`);
}

const missing = (): ConnectorError => new ConnectorError('no such connector', 404);

function ownedRows(subject: string, project: string, dir: string): LocalConnectorRow[] {
  assertLocalOwner(subject, dir);
  if (project !== LOCAL_PROJECT_ID) throw new ConnectorError('no such project', 404);
  return readLocalConnectors(dir);
}

function rowOrThrow(subject: string, id: string, dir: string): LocalConnectorRow {
  assertLocalOwner(subject, dir);
  const row = readLocalConnectors(dir).find((r) => r.id === id);
  if (row === undefined) throw missing();
  return row;
}

function replace(dir: string, row: LocalConnectorRow): Connector {
  writeRows(dir, readLocalConnectors(dir).map((r) => (r.id === row.id ? row : r)));
  return connectorFromRow(row);
}

async function oauthCapable(url: URL, auth: ConnectorAuth): Promise<boolean> {
  if (auth.kind === 'oauth') return true;
  if (auth.kind === 'header') return false;
  return advertisesOAuth(url);
}

export async function localListConnectors(
  subject: string,
  project: string,
  dir = agentsDir(),
): Promise<Connector[]> {
  return Promise.resolve(ownedRows(subject, project, dir).map(connectorFromRow));
}

export async function localGetConnector(subject: string, id: string, dir = agentsDir()): Promise<Connector> {
  return Promise.resolve(connectorFromRow(rowOrThrow(subject, id, dir)));
}

function insert(dir: string, name: string, url: URL, config: ConnectorConfig): Connector {
  const row: LocalConnectorRow = { id: newId(), name, url: connectorUrlText(url), transport: 'http', config };
  writeRows(dir, [...readLocalConnectors(dir), row]);
  return connectorFromRow(row);
}

export async function localCreateConnector(
  subject: string,
  project: string,
  input: ConnectorInput,
  dir = agentsDir(),
): Promise<Connector> {
  ownedRows(subject, project, dir);
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const auth = connectorAuth(input.header, input.value);
  const verified = stamp(await verifyRemoteMcp(url, auth));
  return insert(dir, name, url, {
    auth,
    createdAt: new Date().toISOString(),
    verified,
    oauth: await oauthCapable(url, auth),
  });
}

export async function localCreatePendingConnector(
  subject: string,
  project: string,
  input: { name: unknown; url: unknown },
  dir = agentsDir(),
): Promise<Connector> {
  ownedRows(subject, project, dir);
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  return Promise.resolve(
    insert(dir, name, url, { auth: { kind: 'none' }, createdAt: new Date().toISOString(), verified: UNVERIFIED, oauth: true }),
  );
}

export async function localReconnectConnector(
  subject: string,
  id: string,
  auth: OAuthAuth,
  dir = agentsDir(),
): Promise<Connector> {
  const row = rowOrThrow(subject, id, dir);
  const verified = stamp(await verifyRemoteMcp(parseConnectorUrl(row.url), auth));
  return replace(dir, { ...row, config: { ...row.config, auth, verified, oauth: true } });
}

export async function localDisconnectConnector(subject: string, id: string, dir = agentsDir()): Promise<Connector> {
  const row = rowOrThrow(subject, id, dir);
  if (row.config.auth.kind !== 'oauth') throw new ConnectorError('that connector is not signed in', 400);
  return Promise.resolve(replace(dir, { ...row, config: { ...row.config, auth: { kind: 'none' }, oauth: true } }));
}

async function freshAuth(auth: ConnectorAuth, resource: string): Promise<ConnectorAuth> {
  if (auth.kind !== 'oauth' || !oauthExpired(auth)) return auth;
  return refreshOAuth(auth, resource);
}

export async function localVerifyConnector(subject: string, id: string, dir = agentsDir()): Promise<ConnectorCheck> {
  const row = rowOrThrow(subject, id, dir);
  try {
    const url = parseConnectorUrl(row.url);
    const auth = await freshAuth(row.config.auth, url.toString());
    const verified = stamp(await verifyRemoteMcp(url, auth));
    const oauth = row.config.oauth || (await oauthCapable(url, auth));
    replace(dir, { ...row, config: { ...row.config, auth, verified, oauth } });
    return { id: row.id, name: row.name, ok: true, verified };
  } catch (err) {
    if (!(err instanceof ConnectorVerifyError)) throw err;
    return { id: row.id, name: row.name, ok: false, reason: err.message };
  }
}

const nameClash = (name: string, agent: string): ConnectorError =>
  new ConnectorError(`the agent '${agent}' already has a connector named '${name}'`, 409);

function clashFor(name: string, exceptId: string, agentIds: string[], dir: string): string | null {
  const rows = readLocalConnectors(dir);
  for (const agentId of agentIds) {
    const held = connectorIdsOfLocalAgent(agentId, dir) ?? [];
    const other = rows.find((r) => r.id !== exceptId && held.includes(r.id) && r.name === name);
    if (other !== undefined) return localAgentsWith(other.id, dir).find((a) => a.id === agentId)?.name ?? agentId;
  }
  return null;
}

export async function localRenameConnector(subject: string, id: string, raw: string, dir = agentsDir()): Promise<Connector> {
  const name = connectorName(raw);
  const row = rowOrThrow(subject, id, dir);
  const clash = clashFor(name, id, localAgentsWith(id, dir).map((a) => a.id), dir);
  if (clash !== null) throw nameClash(name, clash);
  return Promise.resolve(replace(dir, { ...row, name }));
}

export async function localDeleteConnector(subject: string, id: string, dir = agentsDir()): Promise<DeletedConnector> {
  const row = rowOrThrow(subject, id, dir);
  writeRows(dir, readLocalConnectors(dir).filter((r) => r.id !== id));
  localDropConnectorEverywhere(id, dir);
  return Promise.resolve({ id: row.id, name: row.name });
}

const byIds = (ids: string[], dir: string): LocalConnectorRow[] =>
  readLocalConnectors(dir).filter((r) => ids.includes(r.id));

export async function localConnectorSummariesByIds(ids: string[], dir = agentsDir()): Promise<ConnectorSummary[]> {
  return Promise.resolve(
    byIds(ids, dir).map((r) => ({ id: r.id, name: r.name, url: r.url, transport: r.transport, signIn: signInState(r.config) })),
  );
}

export async function localConnectorNamesByIds(ids: string[], dir = agentsDir()): Promise<{ id: string; name: string }[]> {
  return Promise.resolve(byIds(ids, dir).map((r) => ({ id: r.id, name: r.name })));
}

export async function localAgentConnectors(subject: string, agentId: string, dir = agentsDir()): Promise<AgentConnectors> {
  const { agent } = await localOwnedAgentOrThrow(subject, agentId, dir);
  return { ...agent, connectorIds: localAgentConnectorIds(subject, agentId, dir) };
}

export async function localAddConnector(subject: string, agentId: string, connectorId: string, dir = agentsDir()): Promise<AgentConnectors> {
  const { agent } = await localOwnedAgentOrThrow(subject, agentId, dir);
  const row = readLocalConnectors(dir).find((r) => r.id === connectorId);
  if (row === undefined) throw missing();
  const held = localAgentConnectorIds(subject, agentId, dir);
  if (!held.includes(connectorId)) {
    const clash = clashFor(row.name, connectorId, [agentId], dir);
    if (clash !== null) throw nameClash(row.name, clash);
    localSetAgentConnectors(subject, agentId, [...held, connectorId], dir);
  }
  return { ...agent, connectorIds: localAgentConnectorIds(subject, agentId, dir) };
}

export async function localRemoveConnector(subject: string, agentId: string, connectorId: string, dir = agentsDir()): Promise<AgentConnectors> {
  const { agent } = await localOwnedAgentOrThrow(subject, agentId, dir);
  const held = localAgentConnectorIds(subject, agentId, dir);
  localSetAgentConnectors(subject, agentId, held.filter((id) => id !== connectorId), dir);
  return { ...agent, connectorIds: localAgentConnectorIds(subject, agentId, dir) };
}

const inflight = new Map<string, Promise<OAuthAuth>>();

function refreshOnce(row: LocalConnectorRow, auth: OAuthAuth, dir: string): Promise<OAuthAuth> {
  const running = inflight.get(row.id);
  if (running !== undefined) return running;
  const job = refreshOAuth(auth, parseConnectorUrl(row.url).toString())
    .then((fresh) => {
      replace(dir, { ...row, config: { ...row.config, auth: fresh } });
      return fresh;
    })
    .finally(() => {
      inflight.delete(row.id);
    });
  inflight.set(row.id, job);
  return job;
}

async function oauthTarget(row: LocalConnectorRow, auth: OAuthAuth, force: boolean, dir: string): Promise<RelayTarget> {
  if (!force && !oauthExpired(auth)) return { kind: 'ok', url: row.url, headers: bearerHeaders(auth.accessToken) };
  try {
    const fresh = await refreshOnce(row, auth, dir);
    return { kind: 'ok', url: row.url, headers: bearerHeaders(fresh.accessToken) };
  } catch (err) {
    log.warn({ id: row.id, err: errMsg(err) }, 'local relay: token refresh failed');
    return unrefreshedTarget(row.url, auth, force);
  }
}

export async function localRelayTarget(
  agentId: string,
  connectorId: string,
  force: boolean,
  dir = agentsDir(),
): Promise<RelayTarget> {
  const held = connectorIdsOfLocalAgent(agentId, dir);
  if (!held?.includes(connectorId)) return { kind: 'missing' };
  const row = readLocalConnectors(dir).find((r) => r.id === connectorId);
  if (row === undefined) return { kind: 'missing' };
  parseConnectorUrl(row.url);
  const auth = row.config.auth;
  if (auth.kind === 'oauth') return oauthTarget(row, auth, force, dir);
  return fixedTarget(row.url, auth, force);
}
