import type { Message } from '@mtcute/bun';
import { lineOf } from './accounts.js';
import { displayName, senderName } from './format.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(n)), MAX_LIMIT);
}

function senderUri(accountId: string, m: Message): string {
  return `metro://telegram-user/${accountId}/user/${m.sender.id}`;
}

function textOf(m: Message): string {
  if (m.text) return m.text;
  if (m.media !== null) return `[${m.media.type}]`;
  return '';
}

export interface ReadMessage {
  id: string;
  ts: string;
  from: string;
  from_name?: string;
  from_display_name?: string;
  text: string;
}

export function shapeHistory(
  accountId: string,
  chatId: number,
  messages: readonly Message[],
): { line: string; count: number; messages: ReadMessage[] } {
  const ordered = [...messages].reverse();
  const shaped = ordered.map((m) => ({
    id: String(m.id),
    ts: m.date.toISOString(),
    from: senderUri(accountId, m),
    from_name: senderName(m.sender),
    from_display_name: displayName(m.sender),
    text: textOf(m),
  }));
  return {
    line: lineOf(accountId, chatId),
    count: shaped.length,
    messages: shaped,
  };
}
