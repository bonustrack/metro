import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAME_RE, ID_RE } from '@metro-labs/core/ids';
import { STATIONS, type StationName } from '@metro-labs/core/station-names';
import type { LoadedAccount, LoadedAgent, StationSource } from '../stations/materialize.js';
import { isRecord } from '@metro-labs/core/is-record';
import { parsePolicy } from '../policy/policy.js';

export const AGENT_FILE = 'agent.json';

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const STATION_NAMES = new Set<string>(STATIONS);

export class AgentFileError extends Error {}

export interface AgentFile {
  version: 1;
  id: string;
  name: string | null;
  key: string | null;
  stations: LoadedAccount[];
}

export const agentFilePath = (dir = agentsDir()): string => join(dir, AGENT_FILE);

export function agentsDir(): string {
  const explicit = process.env.METRO_AGENTS_DIR?.trim();
  return explicit !== undefined && explicit !== ''
    ? explicit
    : join(homedir(), '.metro', 'agents');
}

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

export function approversOf(raw: unknown): { approvers?: string[] } {
  if (!Array.isArray(raw)) return {};
  const list = raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '*' && entry.trim() !== '');
  return list.length === 0 ? {} : { approvers: list };
}

function stationOf(raw: unknown, path: string, index: number): LoadedAccount {
  const where = `stations[${String(index)}]`;
  if (!isRecord(raw)) fail(path, `${where} is not an object`);
  const { station, id, config } = raw;
  if (!isStationName(station)) fail(path, `${where}.station is not a known station`);
  if (typeof id !== 'string' || !ID_RE.test(id))
    fail(path, `${where}.id is not an 11-character id`);
  if (!isRecord(config)) fail(path, `${where}.config is not an object`);
  const policy = parsePolicy(raw.policy, `${path} ${where}`);
  return {
    station,
    id,
    allowlist: allowlistOf(raw.allowlist, path, where),
    ...approversOf(raw.approvers),
    enabled: raw.enabled !== false,
    ...(policy === undefined ? {} : { policy }),
    config,
  };
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

function nameOf(raw: unknown, path: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !AGENT_NAME_RE.test(raw)) fail(path, 'name is not a valid agent name');
  return raw;
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
  const label = nameOf(name, path);
  const key = optionalMatch(parsed.key, KEY_RE, path, 'key is not an agent key');
  if (!Array.isArray(stations)) fail(path, 'stations is not a list');
  return {
    version: 1,
    id,
    name: label,
    key,
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
  const fixed = agentFilePath(dir);
  return existsSync(fixed) ? [fixed] : [];
}

export function loadFileAgents(dir = agentsDir()): LoadedAgent[] {
  return listAgentFiles(dir).map(readAgentFile).map((agent) => ({
    id: agent.id,
    name: agent.name ?? agent.id,
    key: agent.key,
    accounts: agent.stations,
  }));
}

export const fileSource: StationSource = () => Promise.resolve(loadFileAgents());
