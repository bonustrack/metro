import { join } from 'node:path';
import { STATE_DIR } from '../daemon/paths.js';
import { readJson, writeSecure } from '../daemon/secure-fs.js';

export interface AgentTag {
  agent: string;
  agentId: string;
}

export type AgentMap = Record<string, AgentTag>;

const AGENT_MAP_FILE = join(STATE_DIR, 'agent-map.json');

const mapKey = (station: string, accountId: string): string =>
  `${station}/${accountId}`;

export function writeAgentMap(map: AgentMap): void {
  writeSecure(AGENT_MAP_FILE, JSON.stringify(map, null, 2));
}

let cache: AgentMap | null = null;

export function loadAgentMap(): AgentMap {
  cache ??= readJson<AgentMap>(AGENT_MAP_FILE, {});
  return cache;
}

export function agentForLine(line: string): AgentTag | undefined {
  const parts = line.split('/');
  const station = parts[2];
  const accountId = parts[3];
  if (!station || !accountId) return undefined;
  return loadAgentMap()[mapKey(station, accountId)];
}
