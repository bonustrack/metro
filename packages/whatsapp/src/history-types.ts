import type { WAMessage, WAMessageKey, WAMessageUpdate } from 'baileys';
import type { WAMediaRef } from './media.js';

export const HISTORY_LIMITS = Object.freeze({
  days: 30,
  rows: 5000,
  rowsPerChat: 500,
  bytes: 8 * 1024 * 1024,
  textBytes: 16 * 1024,
  tombstones: 5000,
  chatFloors: 1000,
  pageSize: 100,
  pageBytes: 2 * 1024 * 1024,
});

export const HISTORY_SWEEP_MS = 60_000;
export const HISTORY_SAVE_MS = 1000;
export const HISTORY_AGE_MS = HISTORY_LIMITS.days * 86_400_000;

export interface HistoryRow {
  key: WAMessageKey;
  messageId: string;
  chatJid: string;
  senderJid?: string;
  fromMe: boolean;
  timestamp: string;
  text: string;
  truncated?: boolean;
  attachments?: WAMediaRef[];
}

export interface StoredRow {
  key: WAMessageKey;
  at: number;
  senderJid?: string;
  text: string;
  truncated?: boolean;
  attachments?: WAMediaRef[];
  editedAt?: number;
  expiresAt?: number;
}

export interface HistoryOptions {
  limit?: number;
  before?: string;
  since?: string;
}

export interface HistoryPage {
  messages: HistoryRow[];
  count: number;
  hasMore: boolean;
  nextBefore?: string;
  coverage: {
    partial: true;
    source: 'local';
    description: string;
    oldest: string | null;
    newest: string | null;
    retained: number;
    retainedAfter: string;
    limits: typeof HISTORY_LIMITS;
  };
}

export type HistoryDelete = { keys: readonly WAMessageKey[] } | { jid: string; all: true };

export interface History {
  read(jid: string, options?: HistoryOptions): HistoryPage;
  ingest(messages: readonly WAMessage[], selfJid?: string): void;
  update(updates: readonly WAMessageUpdate[], selfJid?: string): void;
  deleteMessages(event: HistoryDelete): void;
  edit(jid: string, messageId: string, text: string): void;
  flush(): void;
  close(): void;
}

export const slotOf = (key: WAMessageKey): string => JSON.stringify([key.remoteJid, key.id]);

export function newestFirst(a: StoredRow, b: StoredRow): number {
  if (a.at !== b.at) return b.at - a.at;
  const left = slotOf(a.key);
  const right = slotOf(b.key);
  return left === right ? 0 : left < right ? 1 : -1;
}
