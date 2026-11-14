import { senderListed } from '@metro-labs/http/sender-list';

export type AgentMap = Record<string, string>;
export type AgentNameMap = Record<string, string>;
export type AllowlistMap = Record<string, string[]>;

const mapKey = (station: string, accountId: string): string =>
  `${station}/${accountId}`;

let agentMap: AgentMap = {};
let agentNames: AgentNameMap = {};
let allowlistMap: AllowlistMap = {};
let approversMap: AllowlistMap = {};
let disabledAccounts = new Set<string>();

export function setAgentMap(map: AgentMap, names: AgentNameMap): void {
  agentMap = map;
  agentNames = names;
}

export const knownAgentIds = (): string[] => Object.keys(agentNames);

export function soleAgent(): { id: string; name?: string } | null {
  const id = Object.keys(agentNames)[0];
  return id === undefined ? null : { id, name: agentNames[id] };
}

export function setAllowlistMap(map: AllowlistMap): void {
  allowlistMap = map;
}

export function setApproversMap(map: AllowlistMap): void {
  approversMap = map;
}

export const approversForAccount = (station: string, accountId: string): string[] => approversMap[mapKey(station, accountId)] ?? [];

export function approversForLine(line: string): string[] {
  const a = accountFromLine(line);
  return a ? approversForAccount(a.station, a.accountId) : [];
}

export const mayApprove = (line: string, from: string): boolean => {
  const approvers = approversForLine(line);
  return approvers.length > 0 && senderMatchesAllowlist(approvers, from);
};

export function setDisabledAccounts(ids: Set<string>): void {
  disabledAccounts = ids;
}

export const accountEnabled = (station: string, accountId: string): boolean => !disabledAccounts.has(mapKey(station, accountId));

export function lineReceives(line: string): boolean {
  const a = accountFromLine(line);
  return a === undefined || accountEnabled(a.station, a.accountId);
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

export interface KnownAccount {
  station: string;
  id: string;
  agentId: string;
}

export function knownAccounts(): KnownAccount[] {
  return Object.entries(agentMap).flatMap(([key, agentId]) => {
    const cut = key.indexOf('/');
    return cut === -1 ? [] : [{ station: key.slice(0, cut), id: key.slice(cut + 1), agentId }];
  });
}

export function stationAgentIds(station: string): string[] {
  const prefix = `${station}/`;
  return Object.entries(agentMap)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, id]) => id);
}

export function allowlistForAccount(station: string, accountId: string): string[] | undefined {
  return allowlistMap[mapKey(station, accountId)];
}

export function allowlistForLine(line: string): string[] | undefined {
  const a = accountFromLine(line);
  return a ? allowlistMap[mapKey(a.station, a.accountId)] : undefined;
}

export function senderPermitted(
  allowlist: string[] | undefined,
  from: string,
  verified?: boolean,
): boolean {
  if (allowlist === undefined || allowlist.length === 0 || allowlist.includes('*')) return true;
  return verified !== false && senderMatchesAllowlist(allowlist, from);
}

export function senderMatchesAllowlist(
  allowlist: string[],
  from: string,
): boolean {
  const sender = from ?? '';
  return senderListed(allowlist, sender) || senderListed(allowlist, sender.split('/').pop() ?? sender);
}
