import { CHAT_EFFORTS, isChatEffort, type ChatEffort } from '@metro-labs/core/chat';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { olderThan } from '@metro-labs/client/api/version';
import { readItem, writeItem } from '@metro-labs/client/platform';

const CHAT_EFFORT_SINCE = '0.1.0-beta.344';
const KEY = 'metro.chat.effort:';

export type EffortChoice = ChatEffort | null;

const WORDS: Record<ChatEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };

export const effortWord = (effort: EffortChoice): string => (effort === null ? 'Default' : WORDS[effort]);

export const EFFORT_CHOICES: readonly EffortChoice[] = [null, ...CHAT_EFFORTS];

export const effortItem = (effort: EffortChoice, technical: boolean): string => (effort === null && technical ? "Default: the Gateway's main-thread level" : effortWord(effort));

export const effortButton = (effort: EffortChoice): string => `${effortWord(effort)} effort`;

export function effortOf(chat: string): EffortChoice {
  const kept = readItem(`${KEY}${chat}`);
  return isChatEffort(kept) ? kept : null;
}

export function keepEffort(chat: string, effort: EffortChoice): void {
  writeItem(`${KEY}${chat}`, effort);
}

export const effortAllowed = (status: ServerStatus | undefined): boolean => status !== undefined && status.state === 'live' && !olderThan(status.version, CHAT_EFFORT_SINCE);

export const effortFor = (status: ServerStatus | undefined, effort: EffortChoice): EffortChoice => (effortAllowed(status) ? effort : null);
