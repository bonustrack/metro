import { existsSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../daemon/api-error.js';
import { ensureSecureDir, writeSecure } from '../daemon/secure-fs.js';
import {
  AgentAdminError,
  newApiKey,
  normalizeAgentName,
  type AgentSummary,
  type CreatedAgent,
  type DeletedAgent,
  type OwnedAgent,
  type ResetAgentKey,
} from './agent-admin.js';
import type { AccountRef } from './account-attach.js';
import {
  AGENT_FILE,
  AgentFileError,
  agentsDir,
  listAgentFiles,
  parseAgentFile,
  readAgentFile,
  type AgentFile,
} from './file-source.js';
import { newId } from './ids.js';
import { registerKey, rotateAgentKey, unregisterAgentKey } from './key-map.js';
import { MOVABLE_STATIONS, type LoadedAgent } from './materialize.js';
import type { StationName } from './stations.js';
import { normalizeAddress } from './address.js';

export const LOCAL_PROJECT_ID = 'localdaemon';
const OWNER_FILE = '.owner';

interface Stored {
  path: string;
  file: AgentFile;
}

const missing = (): AgentAdminError => new AgentAdminError('no such agent', 404);

export function localOwner(dir = agentsDir()): string | null {
  try {
    return normalizeAddress(readFileSync(join(dir, OWNER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function setLocalOwner(raw: string, dir = agentsDir()): string {
  const address = normalizeAddress(raw);
  if (address === null) throw new ApiError(`'${raw}' is not an Ethereum address`, 400);
  ensureSecureDir(dir);
  writeSecure(join(dir, OWNER_FILE), `${address}\n`);
  return address;
}


function isOwner(subject: string, dir: string): boolean {
  const owner = localOwner(dir);
  return owner !== null && owner === normalizeAddress(subject);
}

function storedAgents(dir: string): Stored[] {
  return listAgentFiles(dir).map((path) => ({ path, file: readAgentFile(path) }));
}

function save(stored: Stored): void {
  writeSecure(stored.path, `${JSON.stringify(stored.file, null, 2)}\n`);
}

function ownedOrThrow(subject: string, id: string, dir: string): Stored {
  if (!isOwner(subject, dir)) throw missing();
  const found = storedAgents(dir).find((s) => s.file.id === id);
  if (found === undefined) throw missing();
  return found;
}

export async function localOwnedAgentOrThrow(
  subject: string,
  id: string,
  dir = agentsDir(),
): Promise<{ agent: OwnedAgent }> {
  const { file } = ownedOrThrow(subject, id, dir);
  return Promise.resolve({ agent: { id: file.id, name: file.name } });
}

export async function localListAgents(
  subject: string,
  project: string,
  dir = agentsDir(),
): Promise<AgentSummary[]> {
  if (project !== LOCAL_PROJECT_ID || !isOwner(subject, dir))
    throw new AgentAdminError('no such project', 404);
  return Promise.resolve(
    storedAgents(dir)
      .map(({ file }) => ({ id: file.id, name: file.name, owned: true, key: file.key }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  );
}

function freshId(taken: Set<string>): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newId();
    if (!taken.has(id)) return id;
  }
  throw new AgentAdminError('could not allocate a free id', 500);
}

export async function localCreateAgent(
  subject: string,
  project: string,
  rawName: string,
  dir = agentsDir(),
): Promise<CreatedAgent> {
  if (project !== LOCAL_PROJECT_ID || !isOwner(subject, dir))
    throw new AgentAdminError('no such project', 404);
  const name = normalizeAgentName(rawName);
  const folder = join(dir, name);
  if (existsSync(join(folder, AGENT_FILE)))
    throw new AgentAdminError(
      `an agent named '${name}' already exists on this machine`,
      409,
    );
  const existing = storedAgents(dir);
  const id = freshId(new Set(existing.map((s) => s.file.id)));
  const key = newApiKey();
  ensureSecureDir(folder);
  save({
    path: join(folder, AGENT_FILE),
    file: { version: 1, id, name, key, owner: localOwner(dir), stations: [], connectors: [] },
  });
  registerKey(key, id);
  return Promise.resolve({ id, name, key });
}

export async function localResetAgentKey(
  subject: string,
  id: string,
  dir = agentsDir(),
): Promise<ResetAgentKey> {
  const stored = ownedOrThrow(subject, id, dir);
  const key = newApiKey();
  stored.file.key = key;
  save(stored);
  rotateAgentKey(id, key);
  return Promise.resolve({ id, name: stored.file.name, key });
}

export async function localDeleteAgent(
  subject: string,
  id: string,
  dir = agentsDir(),
): Promise<DeletedAgent> {
  const stored = ownedOrThrow(subject, id, dir);
  const attached = stored.file.stations.length;
  if (attached > 0)
    throw new AgentAdminError(
      `agent '${stored.file.name}' still has ${String(attached)} station account(s) attached — detach them first`,
      409,
    );
  rmSync(stored.path);
  removeIfEmpty(join(stored.path, '..'));
  unregisterAgentKey(id);
  return Promise.resolve({ id, name: stored.file.name });
}

function assertUnclaimed(existing: Stored[], agent: LoadedAgent): void {
  for (const { file } of existing) {
    if (file.id === agent.id)
      throw new AgentAdminError(`agent ${agent.id} is already on this machine`, 409);
    if (agent.key !== null && file.key === agent.key)
      throw new AgentAdminError('that agent key is already on this machine', 409);
  }
}

export function assertLocalOwner(subject: string, dir = agentsDir()): void {
  if (!isOwner(subject, dir)) throw new AgentAdminError('no such project', 404);
}

function assertImportable(agent: LoadedAgent): asserts agent is LoadedAgent & { key: string } {
  const immovable = agent.accounts.find((a) => !MOVABLE_STATIONS.has(a.station));
  if (immovable !== undefined)
    throw new AgentAdminError(
      `a ${immovable.station} endpoint needs a public url and cannot live on a local daemon`,
      400,
    );
  if (agent.key === null)
    throw new AgentAdminError('that agent has no key; reset it on metro.box first', 400);
}

interface ImportTarget {
  path: string;
  previous: AgentFile | undefined;
}

function importTarget(dir: string, agent: LoadedAgent & { key: string }): ImportTarget {
  const existing = storedAgents(dir);
  const same = existing.find((s) => s.file.id === agent.id);
  const fresh = join(dir, agent.name, AGENT_FILE);
  if (same === undefined && existsSync(fresh))
    throw new AgentAdminError(
      `an agent named '${agent.name}' already exists on this machine`,
      409,
    );
  assertUnclaimed(existing.filter((s) => s !== same), agent);
  return { path: same?.path ?? fresh, previous: same?.file };
}

export async function localImportAgent(
  subject: string,
  agent: LoadedAgent,
  dir = agentsDir(),
): Promise<{ id: string; name: string; key: string; stations: number }> {
  assertLocalOwner(subject, dir);
  assertImportable(agent);
  const { path, previous } = importTarget(dir, agent);
  const file = fileFor(agent, localOwner(dir), path, previous);
  ensureSecureDir(join(path, '..'));
  save({ path, file });
  if (previous !== undefined && previous.key !== agent.key) unregisterAgentKey(agent.id);
  registerKey(agent.key, agent.id);
  return Promise.resolve({
    id: agent.id,
    name: agent.name,
    key: agent.key,
    stations: file.stations.length,
  });
}

function mergedStations(agent: LoadedAgent, previous: AgentFile | undefined): AgentFile['stations'] {
  const fromMetro = agent.accounts.map((a) => ({ ...a, allowlist: a.allowlist ?? ['*'] }));
  const kept = (previous?.stations ?? []).filter(
    (s) => !fromMetro.some((m) => m.station === s.station && m.id === s.id),
  );
  return [...fromMetro, ...kept];
}

function fileFor(
  agent: LoadedAgent,
  owner: string | null,
  path: string,
  previous?: AgentFile,
): AgentFile {
  try {
    return parseAgentFile(
      JSON.stringify({
        version: 1,
        id: agent.id,
        name: previous?.name ?? agent.name,
        key: agent.key,
        owner,
        stations: mergedStations(agent, previous),
        connectors: previous?.connectors ?? [],
      }),
      path,
    );
  } catch (err) {
    if (err instanceof AgentFileError)
      throw new AgentAdminError(`metro's copy of this agent cannot be written here: ${err.message}`, 400);
    throw err;
  }
}

export function readLocalAgentFile(agentId: string, dir = agentsDir()): AgentFile {
  const found = storedAgents(dir).find((s) => s.file.id === agentId);
  if (found === undefined) throw missing();
  return found.file;
}

export function connectorIdsOfLocalAgent(agentId: string, dir = agentsDir()): string[] | null {
  const found = storedAgents(dir).find((s) => s.file.id === agentId);
  return found === undefined ? null : found.file.connectors;
}

export function localAgentConnectorIds(subject: string, agentId: string, dir = agentsDir()): string[] {
  return ownedOrThrow(subject, agentId, dir).file.connectors;
}

export function localSetAgentConnectors(
  subject: string,
  agentId: string,
  ids: string[],
  dir = agentsDir(),
): void {
  const stored = ownedOrThrow(subject, agentId, dir);
  stored.file.connectors = ids;
  save(stored);
}

export function localHoldEverywhere(connectorId: string, dir = agentsDir()): void {
  for (const stored of storedAgents(dir)) {
    if (stored.file.connectors.includes(connectorId)) continue;
    stored.file.connectors = [...stored.file.connectors, connectorId];
    save(stored);
  }
}

export function localDropConnectorEverywhere(connectorId: string, dir = agentsDir()): void {
  for (const stored of storedAgents(dir)) {
    if (!stored.file.connectors.includes(connectorId)) continue;
    stored.file.connectors = stored.file.connectors.filter((id) => id !== connectorId);
    save(stored);
  }
}

function removeIfEmpty(folder: string): void {
  try {
    rmdirSync(folder);
  } catch {
    return;
  }
}

function assertTokenFree(all: Stored[], station: StationName, token: string): void {
  const taken = all.some((s) =>
    s.file.stations.some(
      (a) => a.station === station && a.config.token === token,
    ),
  );
  if (taken)
    throw new AgentAdminError(
      'that bot token is already attached to an agent on this machine',
      409,
    );
}

export async function localAttachAccount(
  subject: string,
  agentId: string,
  station: StationName,
  config: Record<string, unknown>,
  dir = agentsDir(),
): Promise<AccountRef> {
  const stored = ownedOrThrow(subject, agentId, dir);
  if (!MOVABLE_STATIONS.has(station))
    throw new AgentAdminError(
      `a ${station} endpoint needs a public url and cannot live on a local daemon`,
      400,
    );
  const token = config.token;
  if (typeof token === 'string') assertTokenFree(storedAgents(dir), station, token);
  const taken = new Set(stored.file.stations.map((a) => a.id));
  const accountId = freshId(taken);
  stored.file.stations.push({ station, id: accountId, allowlist: ['*'], config });
  save(stored);
  return Promise.resolve({ agentId, station, accountId });
}

export async function localDetachAccount(
  subject: string,
  agentId: string,
  station: StationName,
  accountId: string,
  dir = agentsDir(),
): Promise<AccountRef> {
  const stored = ownedOrThrow(subject, agentId, dir);
  const before = stored.file.stations.length;
  stored.file.stations = stored.file.stations.filter(
    (a) => !(a.station === station && a.id === accountId),
  );
  if (stored.file.stations.length === before)
    throw new AgentAdminError('no such account on this agent', 404);
  save(stored);
  return Promise.resolve({ agentId, station, accountId });
}
