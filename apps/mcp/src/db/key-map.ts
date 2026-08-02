import { createHash } from 'node:crypto';

const digest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

let agentIdByKeyHash = new Map<string, number>();

export interface KeyOwner {
  key: string;
  agentId: number;
}

const usable = (e: KeyOwner): boolean =>
  e.key !== '' && Number.isInteger(e.agentId) && e.agentId > 0;

export function setKeyMap(entries: KeyOwner[]): void {
  agentIdByKeyHash = new Map(
    entries.filter(usable).map((e) => [digest(e.key), e.agentId]),
  );
}

export function registerKey(key: string, agentId: number): void {
  if (!usable({ key, agentId })) return;
  agentIdByKeyHash.set(digest(key), agentId);
}

export function unregisterAgentKeys(agentId: number): void {
  for (const [hash, id] of agentIdByKeyHash)
    if (id === agentId) agentIdByKeyHash.delete(hash);
}

export function agentIdForKey(token: string): number | undefined {
  if (token === '') return undefined;
  return agentIdByKeyHash.get(digest(token));
}
