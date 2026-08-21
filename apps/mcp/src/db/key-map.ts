import { createHash } from 'node:crypto';
import { ID_RE } from './ids.js';

const digest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

let agentIdByKeyHash = new Map<string, string>();

export interface KeyOwner {
  key: string;
  agentId: string;
}

const usable = (e: KeyOwner): boolean =>
  e.key !== '' && ID_RE.test(e.agentId);

export function setKeyMap(entries: KeyOwner[]): void {
  agentIdByKeyHash = new Map(
    entries.filter(usable).map((e) => [digest(e.key), e.agentId]),
  );
}

export function registerKey(key: string, agentId: string): void {
  if (!usable({ key, agentId })) return;
  agentIdByKeyHash.set(digest(key), agentId);
}

export function unregisterAgentKey(agentId: string): void {
  for (const [hash, id] of agentIdByKeyHash)
    if (id === agentId) agentIdByKeyHash.delete(hash);
}

export function rotateAgentKey(agentId: string, key: string | null): void {
  unregisterAgentKey(agentId);
  if (key !== null) registerKey(key, agentId);
}

export function agentIdForKey(token: string): string | undefined {
  if (token === '') return undefined;
  return agentIdByKeyHash.get(digest(token));
}

export function hasAnyKey(): boolean {
  return agentIdByKeyHash.size > 0;
}
