export type AgentMap = Record<string, string>;
export type AgentNameMap = Record<string, string>;
export type AllowlistMap = Record<string, string[]>;

const mapKey = (station: string, accountId: string): string =>
  `${station}/${accountId}`;

let agentMap: AgentMap = {};
let agentNames: AgentNameMap = {};
let allowlistMap: AllowlistMap = {};

export function setAgentMap(map: AgentMap, names: AgentNameMap): void {
  agentMap = map;
  agentNames = names;
}

export function setAllowlistMap(map: AllowlistMap): void {
  allowlistMap = map;
}

export function accountFromLine(
  line: string,
): { station: string; accountId: string } | undefined {
  const parts = line.split('/');
  const station = parts[2];
  const accountId = parts[3];
  if (!station || !accountId) return undefined;
  return { station, accountId };
}

export function agentIdForAccount(
  station: string,
  accountId: string,
): string | undefined {
  return agentMap[mapKey(station, accountId)];
}

export function agentIdForLine(line: string): string | undefined {
  const a = accountFromLine(line);
  return a ? agentIdForAccount(a.station, a.accountId) : undefined;
}

export function agentForLine(line: string): string | undefined {
  const id = agentIdForLine(line);
  return id === undefined ? undefined : agentNames[id];
}

export function stationAgentIds(station: string): string[] {
  const prefix = `${station}/`;
  return Object.entries(agentMap)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, id]) => id);
}

export function allowlistForLine(line: string): string[] | undefined {
  const a = accountFromLine(line);
  return a ? allowlistMap[mapKey(a.station, a.accountId)] : undefined;
}

export function senderMatchesAllowlist(
  allowlist: string[],
  from: string,
): boolean {
  if (allowlist.length === 0 || allowlist.includes('*')) return true;
  const f = (from ?? '').toLowerCase();
  const id = f.split('/').pop() ?? f;
  return allowlist.some((a) => {
    const v = a.toLowerCase();
    return v === f || v === id;
  });
}
