import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';
import {
  newApiKey,
  AgentAdminError,
  normalizeAgentName,
  type AgentSummary,
  type CreatedAgent,
} from './admin.js';
import type { AccountRef } from './account-attach.js';
import {
  agentFilePath,
  AgentFileError,
  agentsDir,
  listAgentFiles,
  parseAgentFile,
  readAgentFile,
  type AgentFile,
} from './files.js';
import { newId } from '@metro-labs/core/ids';
import { registerKey } from './keys.js';
import { MOVABLE_STATIONS, type LoadedAgent } from '../stations/materialize.js';
import type { StationName } from '@metro-labs/core/station-names';

const OWNER_FILE = '.owner';

interface Stored {
  path: string;
  file: AgentFile;
}

const missing = (): AgentAdminError => new AgentAdminError('no such agent', 404);

export function parseOwner(raw: string): string | null {
  const text = raw.trim();
  return isOrganizationId(text) ? text : null;
}

export function localOwner(dir = agentsDir()): string | null {
  try {
    return parseOwner(readFileSync(join(dir, OWNER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function setLocalOwner(raw: string, dir = agentsDir()): string {
  const owner = parseOwner(raw);
  if (owner === null) throw new ApiError(`'${raw}' is not an organization id`, 400);
  ensureSecureDir(dir);
  writeSecure(join(dir, OWNER_FILE), `${owner}\n`);
  return owner;
}

export function storedAgents(dir: string): Stored[] {
  return listAgentFiles(dir).map((path) => ({ path, file: readAgentFile(path) }));
}

function save(stored: Stored): void {
  writeSecure(stored.path, `${JSON.stringify(stored.file, null, 2)}\n`);
}

function agentOrThrow(id: string, dir: string): Stored {
  const found = storedAgents(dir).find((s) => s.file.id === id);
  if (found === undefined) throw missing();
  return found;
}

export async function localListAgents(dir = agentsDir()): Promise<AgentSummary[]> {
  return Promise.resolve(storedAgents(dir).map(({ file }) => ({ id: file.id, name: file.name })));
}

function freshId(taken: Set<string>): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newId();
    if (!taken.has(id)) return id;
  }
  throw new AgentAdminError('could not allocate a free id', 500);
}

export async function localCreateAgent(rawName?: string, dir = agentsDir()): Promise<CreatedAgent> {
  const name = rawName === undefined ? null : normalizeAgentName(rawName);
  const existing = storedAgents(dir);
  if (existing.length > 0) throw new AgentAdminError('this box already has its agent', 409);
  const id = freshId(new Set());
  const key = newApiKey();
  ensureSecureDir(dir);
  save({
    path: agentFilePath(dir),
    file: { version: 1, id, name, key, stations: [] },
  });
  registerKey(key, id);
  return Promise.resolve({ id, name, key });
}

export type Ensured = 'created' | 'present' | 'no-owner';

export async function ensureLocalAgent(dir = agentsDir()): Promise<Ensured> {
  if (storedAgents(dir).length > 0) return 'present';
  if (localOwner(dir) === null) return 'no-owner';
  await localCreateAgent(undefined, dir);
  return 'created';
}

function assertUnclaimed(existing: Stored[], agent: LoadedAgent): void {
  for (const { file } of existing) {
    if (file.id === agent.id)
      throw new AgentAdminError(`agent ${agent.id} is already on this machine`, 409);
    if (agent.key !== null && file.key === agent.key)
      throw new AgentAdminError('that agent key is already on this machine', 409);
  }
}

function assertImportable(agent: LoadedAgent): void {
  const immovable = agent.accounts.find((a) => !MOVABLE_STATIONS.has(a.station));
  if (immovable !== undefined)
    throw new AgentAdminError(
      `a ${immovable.station} endpoint needs a public url and cannot live on a local daemon`,
      400,
    );
}

interface ImportTarget {
  path: string;
  previous: AgentFile | undefined;
}

function importTarget(dir: string, agent: LoadedAgent): ImportTarget {
  const existing = storedAgents(dir);
  const same = existing.find((s) => s.file.id === agent.id);
  if (same === undefined && existing.length > 0)
    throw new AgentAdminError('this box already has its agent; import into it rather than bringing another', 409);
  assertUnclaimed(existing.filter((s) => s !== same), agent);
  return { path: same?.path ?? agentFilePath(dir), previous: same?.file };
}

export type ImportMode = 'append' | 'overwrite';

export async function localImportAgent(
  agent: LoadedAgent,
  dir = agentsDir(),
  mode: ImportMode = 'overwrite',
): Promise<{ id: string; name: string; key: string; stations: number }> {
  assertImportable(agent);
  const { path, previous } = importTarget(dir, agent);
  const key = previous?.key ?? agent.key ?? newApiKey();
  const file = fileFor({ ...agent, key }, path, previous, mode);
  ensureSecureDir(join(path, '..'));
  save({ path, file });
  registerKey(key, agent.id);
  return Promise.resolve({
    id: agent.id,
    name: agent.name,
    key,
    stations: file.stations.length,
  });
}

function mergedStations(
  agent: LoadedAgent,
  previous: AgentFile | undefined,
  mode: ImportMode,
): AgentFile['stations'] {
  const before = previous?.stations ?? [];
  const here = (station: string, id: string): boolean => before.some((s) => s.station === station && s.id === id);
  const fromMetro = agent.accounts
    .map((a) => ({ ...a, allowlist: a.allowlist ?? ['*'] }))
    .filter((m) => mode === 'overwrite' || !here(m.station, m.id));
  const kept = before.filter((s) => !fromMetro.some((m) => m.station === s.station && m.id === s.id));
  return [...fromMetro, ...kept];
}

function fileFor(
  agent: LoadedAgent,
  path: string,
  previous: AgentFile | undefined,
  mode: ImportMode,
): AgentFile {
  try {
    return parseAgentFile(
      JSON.stringify({
        version: 1,
        id: agent.id,
        name: previous?.name ?? null,
        key: agent.key,
        stations: mergedStations(agent, previous, mode),
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

const UNIQUE_CREDENTIALS: Record<string, string> = {
  token: 'that bot token is already attached to an agent on this machine',
  accountEmail: 'that mailbox is already connected to an agent on this machine',
};

function assertCredentialFree(all: Stored[], station: StationName, config: Record<string, unknown>): void {
  for (const [key, refusal] of Object.entries(UNIQUE_CREDENTIALS)) {
    const value = config[key];
    if (typeof value !== 'string') continue;
    const taken = all.some((s) => s.file.stations.some((a) => a.station === station && a.config[key] === value));
    if (taken) throw new AgentAdminError(refusal, 409);
  }
}

export async function localAttachAccount(
  agentId: string,
  station: StationName,
  config: Record<string, unknown>,
  dir = agentsDir(),
): Promise<AccountRef> {
  const stored = agentOrThrow(agentId, dir);
  if (!MOVABLE_STATIONS.has(station))
    throw new AgentAdminError(
      `a ${station} endpoint needs a public url and cannot live on a local daemon`,
      400,
    );
  assertCredentialFree(storedAgents(dir), station, config);
  const taken = new Set(stored.file.stations.map((a) => a.id));
  const accountId = freshId(taken);
  stored.file.stations.push({ station, id: accountId, allowlist: ['*'], enabled: true, config });
  save(stored);
  return Promise.resolve({ agentId, station, accountId });
}

export async function localSetAllowlist(
  agentId: string,
  station: StationName,
  accountId: string,
  allowlist: string[],
  dir = agentsDir(),
): Promise<string[]> {
  const stored = agentOrThrow(agentId, dir);
  const account = stored.file.stations.find((a) => a.station === station && a.id === accountId);
  if (account === undefined) throw new AgentAdminError('no such account on this agent', 404);
  account.allowlist = allowlist;
  save(stored);
  return Promise.resolve(allowlist);
}

export async function localSetAccountEnabled(
  agentId: string,
  station: StationName,
  accountId: string,
  enabled: boolean,
  dir = agentsDir(),
): Promise<boolean> {
  const stored = agentOrThrow(agentId, dir);
  const account = stored.file.stations.find((a) => a.station === station && a.id === accountId);
  if (account === undefined) throw new AgentAdminError('no such account on this agent', 404);
  account.enabled = enabled;
  save(stored);
  return Promise.resolve(enabled);
}

export async function localDetachAccount(
  agentId: string,
  station: StationName,
  accountId: string,
  dir = agentsDir(),
): Promise<AccountRef> {
  const stored = agentOrThrow(agentId, dir);
  const before = stored.file.stations.length;
  stored.file.stations = stored.file.stations.filter(
    (a) => !(a.station === station && a.id === accountId),
  );
  if (stored.file.stations.length === before)
    throw new AgentAdminError('no such account on this agent', 404);
  save(stored);
  return Promise.resolve({ agentId, station, accountId });
}
