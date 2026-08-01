import { createHash } from 'node:crypto';

const digest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

let agentByKeyHash = new Map<string, string>();

export interface KeyOwner {
  key: string;
  agent: string;
}

export function setKeyMap(entries: KeyOwner[]): void {
  agentByKeyHash = new Map(
    entries
      .filter((e) => e.key !== '' && e.agent !== '')
      .map((e) => [digest(e.key), e.agent]),
  );
}

export function registerKey(key: string, agent: string): void {
  if (key === '' || agent === '') return;
  agentByKeyHash.set(digest(key), agent);
}

export function agentForKey(token: string): string | undefined {
  if (token === '') return undefined;
  return agentByKeyHash.get(digest(token));
}
