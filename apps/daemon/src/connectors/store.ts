import { join } from 'node:path';
import { syncPluginServers } from './plugin-sync.js';
import { registerConnectors } from './gates.js';
import type { ToolPolicy } from '../policy/policy.js';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import { listRemoteTools, type RemoteTool } from './tools.js';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { errMsg, log } from '@metro-labs/core/log';
import {
  authHeaders,
  connectorUrlText,
  ConnectorVerifyError,
  parseConnectorUrl,
  verifyRemoteMcp,
  type ConnectorAuth,
  type OAuthAuth,
  type VerifiedRecord,
} from './verify.js';
import { oauthExpired, refreshOAuth } from './oauth.js';
import { advertisesOAuth } from './oauth-discovery.js';
import {
  ConnectorError,
  connectorAuth,
  connectorClient,
  connectorName,
  readConfig,
  signInState,
  stamp,
  type ConnectorConfig,
  type ConnectorSignIn,
} from './config.js';
import type { OAuthClient } from './oauth-client.js';
import { agentsDir } from '../agents/files.js';
import { newId } from '@metro-labs/core/ids';
import type { LoadedConnector } from '../stations/materialize.js';

export interface LocalConnectorRow {
  id: string;
  name: string;
  url: string;
  config: ConnectorConfig;
}

export interface Connector {
  id: string;
  name: string;
  url: string;
  auth: ConnectorAuth['kind'];
  header: string | null;
  signIn: ConnectorSignIn;
  verified: VerifiedRecord;
  client: OAuthClient | null;
  policy: ToolPolicy;
}

export interface PendingConnectorInput {
  name: unknown;
  url: unknown;
  clientId: unknown;
  clientSecret: unknown;
}

export interface ConnectorInput extends PendingConnectorInput {
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

const UNVERIFIED = { at: '', server: '' };

function connectorFromRow(row: LocalConnectorRow): Connector {
  const auth = row.config.auth;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    auth: auth.kind,
    header: auth.kind === 'header' ? auth.name : null,
    signIn: signInState(row.config),
    verified: row.config.verified,
    client: row.config.client,
    policy: row.config.policy ?? {},
  };
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
    config: readConfig(r.config),
  }));
}

function writeRows(dir: string, rows: LocalConnectorRow[]): void {
  writeSecure(filePath(dir), `${JSON.stringify({ version: 1, connectors: rows }, null, 2)}\n`);
  if (dir !== agentsDir()) return;
  syncPluginServers(rows);
  registerConnectors(rows);
}

const missing = (): ConnectorError => new ConnectorError('no such connector', 404);

function rowOrThrow(id: string, dir: string): LocalConnectorRow {
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

export function localImportConnectors(
  rows: LoadedConnector[],
  dir = agentsDir(),
  mode: 'append' | 'overwrite' = 'overwrite',
): number {
  const current = readLocalConnectors(dir);
  const fresh =
    mode === 'overwrite'
      ? rows
      : rows.filter((row) => !current.some((r) => r.id === row.id || r.name === row.name));
  const imported: LocalConnectorRow[] = fresh.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    config: readConfig(row.config),
  }));
  const ids = new Set(imported.map((r) => r.id));
  const names = new Set(imported.map((r) => r.name));
  writeRows(dir, [...current.filter((r) => !ids.has(r.id) && !names.has(r.name)), ...imported]);
  return imported.length;
}

export async function localListConnectors(dir = agentsDir()): Promise<Connector[]> {
  return Promise.resolve(readLocalConnectors(dir).map(connectorFromRow));
}

export async function localGetConnector(id: string, dir = agentsDir()): Promise<Connector> {
  return Promise.resolve(connectorFromRow(rowOrThrow(id, dir)));
}

function assertNameFree(name: string, exceptId: string | null, dir: string): void {
  if (readLocalConnectors(dir).some((r) => r.id !== exceptId && r.name === name))
    throw new ConnectorError(`a connector named '${name}' already exists on this daemon`, 409);
}

function insert(dir: string, name: string, url: URL, config: ConnectorConfig): Connector {
  assertNameFree(name, null, dir);
  const row: LocalConnectorRow = { id: newId(), name, url: connectorUrlText(url), config };
  writeRows(dir, [...readLocalConnectors(dir), row]);
  return connectorFromRow(row);
}

export async function localCreateConnector(input: ConnectorInput, dir = agentsDir()): Promise<Connector> {
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const auth = connectorAuth(input.header, input.value);
  const client = connectorClient(input.clientId, input.clientSecret);
  const verified = stamp(await verifyRemoteMcp(url, auth));
  return insert(dir, name, url, {
    auth,
    createdAt: new Date().toISOString(),
    verified,
    oauth: await oauthCapable(url, auth),
    client,
  });
}

export async function localCreatePendingConnector(input: PendingConnectorInput, dir = agentsDir()): Promise<Connector> {
  const name = connectorName(input.name);
  const url = parseConnectorUrl(input.url);
  const client = connectorClient(input.clientId, input.clientSecret);
  return Promise.resolve(
    insert(dir, name, url, { auth: { kind: 'none' }, createdAt: new Date().toISOString(), verified: UNVERIFIED, oauth: true, client }),
  );
}

export async function localReconnectConnector(
  id: string,
  auth: OAuthAuth,
  dir = agentsDir(),
): Promise<Connector> {
  const row = rowOrThrow(id, dir);
  const verified = stamp(await verifyRemoteMcp(parseConnectorUrl(row.url), auth));
  return replace(dir, { ...row, config: { ...row.config, auth, verified, oauth: true } });
}

const signedOut = (row: LocalConnectorRow): LocalConnectorRow => ({ ...row, config: { ...row.config, auth: { kind: 'none' }, oauth: true } });

export async function localDisconnectConnector(id: string, dir = agentsDir()): Promise<Connector> {
  const row = rowOrThrow(id, dir);
  if (row.config.auth.kind !== 'oauth') throw new ConnectorError('that connector is not signed in', 400);
  return Promise.resolve(replace(dir, signedOut(row)));
}

export function localMarkSignedOut(id: string, dir = agentsDir()): void {
  const row = readLocalConnectors(dir).find((r) => r.id === id);
  if (row?.config.auth.kind !== 'oauth') return;
  log.info({ id, name: row.name }, 'local relay: the vendor refused the token after a refresh; the connector is signed out');
  replace(dir, signedOut(row));
}

async function freshAuth(row: LocalConnectorRow, dir: string): Promise<ConnectorAuth> {
  const auth = row.config.auth;
  if (auth.kind !== 'oauth' || !oauthExpired(auth)) return auth;
  return refreshOnce(row, auth, dir);
}

function updateRow(dir: string, id: string, config: Partial<LocalConnectorRow['config']>): void {
  const now = readLocalConnectors(dir).find((r) => r.id === id);
  if (now !== undefined) replace(dir, { ...now, config: { ...now.config, ...config } });
}

export async function localVerifyConnector(id: string, dir = agentsDir()): Promise<ConnectorCheck> {
  const row = rowOrThrow(id, dir);
  try {
    const url = parseConnectorUrl(row.url);
    const auth = await freshAuth(row, dir);
    const verified = stamp(await verifyRemoteMcp(url, auth));
    const oauth = row.config.oauth || (await oauthCapable(url, auth));
    updateRow(dir, row.id, { auth, verified, oauth });
    return { id: row.id, name: row.name, ok: true, verified };
  } catch (err) {
    if (!(err instanceof ConnectorVerifyError)) throw err;
    return { id: row.id, name: row.name, ok: false, reason: err.message };
  }
}

const groupsOf = (tools: RemoteTool[]): Record<string, ToolGroup> =>
  Object.fromEntries(tools.map((tool) => [tool.name, tool.readOnly ? 'read' : 'write'] as const));

function keepGroups(dir: string, id: string, tools: RemoteTool[]): void {
  const now = readLocalConnectors(dir).find((r) => r.id === id);
  const groups = groupsOf(tools);
  if (now === undefined || JSON.stringify(now.config.toolGroups ?? {}) === JSON.stringify(groups)) return;
  const config = { ...now.config };
  delete config.toolGroups;
  replace(dir, { ...now, config: Object.keys(groups).length > 0 ? { ...config, toolGroups: groups } : config });
}

export async function localConnectorTools(id: string, dir = agentsDir()): Promise<RemoteTool[]> {
  const row = rowOrThrow(id, dir);
  const url = parseConnectorUrl(row.url);
  const tools = await listRemoteTools(url, await freshAuth(row, dir));
  keepGroups(dir, id, tools);
  return tools;
}

async function refreshGroups(id: string, dir: string): Promise<void> {
  try {
    await localConnectorTools(id, dir);
  } catch (err) {
    log.warn({ id, err: errMsg(err) }, 'connector policy: could not list the tools; the last known read and write groups stay');
  }
}

export async function localSetConnectorPolicy(id: string, policy: ToolPolicy, dir = agentsDir()): Promise<Connector> {
  const row = rowOrThrow(id, dir);
  const config = { ...row.config };
  delete config.policy;
  const saved = replace(dir, { ...row, config: Object.keys(policy).length > 0 ? { ...config, policy } : config });
  await refreshGroups(id, dir);
  return saved;
}

export async function loadConnectorPolicies(dir = agentsDir()): Promise<void> {
  const rows = readLocalConnectors(dir);
  registerConnectors(rows);
  for (const row of rows) if (row.config.policy !== undefined) await refreshGroups(row.id, dir);
}

export async function localRenameConnector(id: string, raw: string, dir = agentsDir()): Promise<Connector> {
  const name = connectorName(raw);
  const row = rowOrThrow(id, dir);
  assertNameFree(name, id, dir);
  return Promise.resolve(replace(dir, { ...row, name }));
}

export async function localDeleteConnector(id: string, dir = agentsDir()): Promise<DeletedConnector> {
  const row = rowOrThrow(id, dir);
  writeRows(dir, readLocalConnectors(dir).filter((r) => r.id !== id));
  return Promise.resolve({ id: row.id, name: row.name });
}

const inflight = new Map<string, Promise<OAuthAuth>>();

function refreshOnce(row: LocalConnectorRow, auth: OAuthAuth, dir: string): Promise<OAuthAuth> {
  const running = inflight.get(row.id);
  if (running !== undefined) return running;
  const job = refreshOAuth(auth, parseConnectorUrl(row.url).toString())
    .then((fresh) => {
      updateRow(dir, row.id, { auth: fresh });
      return fresh;
    })
    .finally(() => {
      inflight.delete(row.id);
    });
  inflight.set(row.id, job);
  return job;
}

export type RelayTarget =
  | { kind: 'ok'; url: string; headers: Record<string, string> }
  | { kind: 'missing' }
  | { kind: 'signin' };

function staleUsable(auth: OAuthAuth, now = Date.now()): boolean {
  return auth.expiresAt === undefined || auth.expiresAt > now;
}

function unrefreshedTarget(
  url: string,
  auth: OAuthAuth,
  force: boolean,
  now = Date.now(),
): RelayTarget {
  if (force) return { kind: 'signin' };
  return { kind: 'ok', url, headers: staleUsable(auth, now) ? authHeaders(auth) : {} };
}

function fixedTarget(
  url: string,
  auth: Exclude<ConnectorAuth, OAuthAuth>,
  force: boolean,
): RelayTarget {
  if (force) return { kind: 'signin' };
  return { kind: 'ok', url, headers: authHeaders(auth) };
}

async function oauthTarget(row: LocalConnectorRow, auth: OAuthAuth, force: boolean, dir: string): Promise<RelayTarget> {
  if (!force && !oauthExpired(auth)) return { kind: 'ok', url: row.url, headers: authHeaders(auth) };
  try {
    const fresh = await refreshOnce(row, auth, dir);
    return { kind: 'ok', url: row.url, headers: authHeaders(fresh) };
  } catch (err) {
    log.warn({ id: row.id, err: errMsg(err) }, 'local relay: token refresh failed');
    return unrefreshedTarget(row.url, auth, force);
  }
}

export async function localRelayTarget(
  connectorId: string,
  force: boolean,
  dir = agentsDir(),
): Promise<RelayTarget> {
  const row = readLocalConnectors(dir).find((r) => r.id === connectorId);
  if (row === undefined) return { kind: 'missing' };
  parseConnectorUrl(row.url);
  const auth = row.config.auth;
  if (auth.kind === 'oauth') return oauthTarget(row, auth, force, dir);
  return fixedTarget(row.url, auth, force);
}
