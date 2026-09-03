import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
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
import type { StationName } from './schema.js';
import { normalizeAddress } from './users.js';

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

function writeOwnerOnce(path: string, address: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  writeSync(fd, `${address}\n`);
  closeSync(fd);
  return true;
}

export function claimLocalOwner(raw: string, dir = agentsDir()): Promise<string> {
  const address = normalizeAddress(raw);
  if (address === null)
    return Promise.reject(new ApiError('an Ethereum address is required', 400));
  ensureSecureDir(dir);
  if (writeOwnerOnce(join(dir, OWNER_FILE), address))
    return Promise.resolve(address);
  if (localOwner(dir) !== address)
    return Promise.reject(
      new ApiError('this machine belongs to another wallet', 403),
    );
  return Promise.resolve(address);
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
    file: { version: 1, id, name, key, owner: localOwner(dir), stations: [] },
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

export async function localImportAgent(
  subject: string,
  agent: LoadedAgent,
  dir = agentsDir(),
): Promise<{ id: string; name: string; key: string; stations: number }> {
  assertLocalOwner(subject, dir);
  const immovable = agent.accounts.find((a) => !MOVABLE_STATIONS.has(a.station));
  if (immovable !== undefined)
    throw new AgentAdminError(
      `a ${immovable.station} endpoint needs a public url and cannot live on a local daemon`,
      400,
    );
  if (agent.key === null)
    throw new AgentAdminError('that agent has no key; reset it on metro.box first', 400);
  const folder = join(dir, agent.name);
  const path = join(folder, AGENT_FILE);
  if (existsSync(path))
    throw new AgentAdminError(
      `an agent named '${agent.name}' already exists on this machine`,
      409,
    );
  assertUnclaimed(storedAgents(dir), agent);
  const file = fileFor(agent, localOwner(dir), path);
  ensureSecureDir(folder);
  save({ path, file });
  registerKey(agent.key, agent.id);
  return Promise.resolve({
    id: agent.id,
    name: agent.name,
    key: agent.key,
    stations: agent.accounts.length,
  });
}

function fileFor(agent: LoadedAgent, owner: string | null, path: string): AgentFile {
  try {
    return parseAgentFile(
      JSON.stringify({
        version: 1,
        id: agent.id,
        name: agent.name,
        key: agent.key,
        owner,
        stations: agent.accounts.map((a) => ({ ...a, allowlist: a.allowlist ?? ['*'] })),
      }),
      path,
    );
  } catch (err) {
    if (err instanceof AgentFileError)
      throw new AgentAdminError(`metro's copy of this agent cannot be written here: ${err.message}`, 400);
    throw err;
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
