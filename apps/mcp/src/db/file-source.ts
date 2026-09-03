import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAME_RE, ID_RE } from './ids.js';
import { STATIONS, type StationName } from './schema.js';
import type { LoadedAccount, LoadedAgent, StationSource } from './materialize.js';

export const AGENT_FILE = 'agent.json';

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const STATION_NAMES = new Set<string>(STATIONS);

export class AgentFileError extends Error {}

export interface AgentFile {
  version: 1;
  id: string;
  name: string;
  key: string | null;
  owner: string | null;
  stations: LoadedAccount[];
}

export function agentsDir(): string {
  const explicit = process.env.METRO_AGENTS_DIR?.trim();
  return explicit !== undefined && explicit !== ''
    ? explicit
    : join(homedir(), '.metro', 'agents');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(path: string, reason: string): never {
  throw new AgentFileError(`${path}: ${reason}`);
}

function isStationName(value: unknown): value is StationName {
  return typeof value === 'string' && STATION_NAMES.has(value);
}

function allowlistOf(raw: unknown, path: string, where: string): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) fail(path, `${where}.allowlist is not a list of strings`);
  const list = raw.filter((entry): entry is string => typeof entry === 'string');
  if (list.length !== raw.length)
    fail(path, `${where}.allowlist is not a list of strings`);
  return list;
}

function stationOf(raw: unknown, path: string, index: number): LoadedAccount {
  const where = `stations[${String(index)}]`;
  if (!isRecord(raw)) fail(path, `${where} is not an object`);
  const { station, id, config } = raw;
  if (!isStationName(station)) fail(path, `${where}.station is not a known station`);
  if (typeof id !== 'string' || !ID_RE.test(id))
    fail(path, `${where}.id is not an 11-character id`);
  if (!isRecord(config)) fail(path, `${where}.config is not an object`);
  return { station, id, allowlist: allowlistOf(raw.allowlist, path, where), config };
}

function optionalMatch(
  value: unknown,
  re: RegExp,
  path: string,
  what: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !re.test(value)) fail(path, what);
  return value;
}

export function parseAgentFile(raw: string, path: string): AgentFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(path, 'is not valid JSON');
  }
  if (!isRecord(parsed)) fail(path, 'is not a JSON object');
  if (parsed.version !== 1) fail(path, 'version must be 1');
  const { id, name, stations } = parsed;
  if (typeof id !== 'string' || !ID_RE.test(id))
    fail(path, 'id is not an 11-character id');
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name))
    fail(path, 'name is not a valid agent name');
  const key = optionalMatch(parsed.key, KEY_RE, path, 'key is not an agent key');
  const owner = optionalMatch(
    parsed.owner,
    ADDRESS_RE,
    path,
    'owner is not a lowercase Ethereum address',
  );
  if (!Array.isArray(stations)) fail(path, 'stations is not a list');
  return {
    version: 1,
    id,
    name,
    key,
    owner,
    stations: stations.map((s, i) => stationOf(s, path, i)),
  };
}

export function readAgentFile(path: string): AgentFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(path, 'cannot be read');
  }
  return parseAgentFile(raw, path);
}

export function listAgentFiles(dir = agentsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, AGENT_FILE))
    .filter((path) => existsSync(path))
    .sort();
}

function assertUnique(agents: AgentFile[], paths: string[]): void {
  const ids = new Map<string, string>();
  const keys = new Map<string, string>();
  agents.forEach((agent, i) => {
    const path = paths[i] ?? '';
    const sameId = ids.get(agent.id);
    if (sameId !== undefined) fail(path, `id ${agent.id} is already used by ${sameId}`);
    ids.set(agent.id, path);
    if (agent.key === null) return;
    const sameKey = keys.get(agent.key);
    if (sameKey !== undefined) fail(path, `its key is already used by ${sameKey}`);
    keys.set(agent.key, path);
  });
}

export function loadFileAgents(dir = agentsDir()): LoadedAgent[] {
  const paths = listAgentFiles(dir);
  const agents = paths.map(readAgentFile);
  assertUnique(agents, paths);
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    key: agent.key,
    accounts: agent.stations,
  }));
}

export const fileSource: StationSource = () => Promise.resolve(loadFileAgents());
