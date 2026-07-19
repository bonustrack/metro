export interface AgentTag {
  agent: string;
  agentId: string;
}

export type AgentMap = Record<string, AgentTag>;

const mapKey = (station: string, accountId: string): string =>
  `${station}/${accountId}`;

let agentMap: AgentMap = {};

export function setAgentMap(map: AgentMap): void {
  agentMap = map;
}

export function agentForLine(line: string): AgentTag | undefined {
  const parts = line.split('/');
  const station = parts[2];
  const accountId = parts[3];
  if (!station || !accountId) return undefined;
  return agentMap[mapKey(station, accountId)];
}
