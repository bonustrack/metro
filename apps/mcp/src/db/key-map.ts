import { createHash } from 'node:crypto';

const digest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

let agentIdByKeyHash = new Map<string, number>();
let keyByAgentId = new Map<number, string>();

export interface KeyOwner {
  key: string;
  agentId: number;
}

const usable = (e: KeyOwner): boolean =>
  e.key !== '' && Number.isInteger(e.agentId) && e.agentId > 0;

export function setKeyMap(entries: KeyOwner[]): void {
  const live = entries.filter(usable);
  agentIdByKeyHash = new Map(live.map((e) => [digest(e.key), e.agentId]));
  keyByAgentId = new Map(live.map((e) => [e.agentId, e.key]));
}

export function registerKey(key: string, agentId: number): void {
  if (!usable({ key, agentId })) return;
  agentIdByKeyHash.set(digest(key), agentId);
  keyByAgentId.set(agentId, key);
}

export function unregisterAgentKey(agentId: number): void {
  for (const [hash, id] of agentIdByKeyHash)
    if (id === agentId) agentIdByKeyHash.delete(hash);
  keyByAgentId.delete(agentId);
}

export function agentIdForKey(token: string): number | undefined {
  if (token === '') return undefined;
  return agentIdByKeyHash.get(digest(token));
}

export function keyForAgent(agentId: number): string | undefined {
  return keyByAgentId.get(agentId);
}

export function hasAnyKey(): boolean {
  return agentIdByKeyHash.size > 0;
}
