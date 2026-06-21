import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { errMsg, log } from './log.js';
import { HISTORY_FILE } from './paths.js';
import { Line } from './lines.js';

export {
  userSelf,
  daemonSelf,
  selfLine,
  noteUserFromLine,
} from './history-identity.js';
export type {
  StructuredEvent,
  WireEvent,
  HistoryEntry,
} from './history-types.js';

import type { HistoryEntry, StructuredEvent } from './history-types.js';

function isExternalWebhook(e: HistoryEntry): boolean {
  return e.station === 'webhook' && !Line.isLocal(e.from);
}

function webhookEventName(e: HistoryEntry): string | undefined {
  const headers = (e.payload as { headers?: Record<string, string> } | undefined)
    ?.headers;
  return headers?.['x-github-event'] ?? headers?.['x-intercom-topic'];
}

export function classifyEvent(e: HistoryEntry): StructuredEvent {
  if (isExternalWebhook(e)) {
    return {
      type: 'system',
      source: 'webhook',
      eventName: webhookEventName(e),
    };
  }
  const emoji =
    (e.payload as { emoji?: string } | undefined)?.emoji ??
    e.text?.match(/^\[react (.+)\]$/)?.[1];
  if (emoji) return { type: 'react', emoji, targetId: e.replyTo };
  if (e.replyTo) return { type: 'reply', replyTo: e.replyTo };
  return { type: 'msg' };
}

export function formatDisplay(e: HistoryEntry): string {
  const headerFor = (icon: string, parts: (string | undefined)[]): string =>
    `**${icon} ${parts.filter(Boolean).join(' · ')}**`;
  const body = e.text ?? '';
  if (isExternalWebhook(e)) {
    const ev = webhookEventName(e);
    return `${headerFor('🪝', ['webhook', e.lineName, ev])}\n> ${body}`;
  }
  if (Line.isLocal(e.from)) {
    return `${headerFor('📤', [e.station, '→', e.fromName ?? e.to])}\n> ${body}`;
  }
  return `${headerFor('📩', [e.station, e.fromName ?? e.from, e.lineName])}\n> ${body}`;
}

export const mintId = (): string =>
  `msg_${randomBytes(6).toString('base64url')}`;

export function appendHistory(entry: HistoryEntry): void {
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    log.warn({ err: errMsg(err), path: HISTORY_FILE }, 'history append failed');
  }
}

export interface HistoryFilter {
  line?: string;
  station?: string;
  from?: string;
  textContains?: string;
  since?: Date;
  limit?: number;
  skip?: number;
}

function parseEntry(raw: string): HistoryEntry | null {
  try {
    return JSON.parse(raw) as HistoryEntry;
  } catch {
    return null;
  }
}

function matchingEntry(raw: string, filter: HistoryFilter): HistoryEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const e = parseEntry(trimmed);
  return e && matches(e, filter) ? e : null;
}

export function readHistory(filter: HistoryFilter = {}): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n');
  const out: HistoryEntry[] = [];
  const skip = filter.skip ?? 0;
  let skipped = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = matchingEntry(lines[i], filter);
    if (!e) continue;
    if (skipped < skip) {
      skipped++;
      continue;
    }
    out.push(e);
    if (filter.limit && out.length >= filter.limit) break;
  }
  return out;
}

function textMatches(e: HistoryEntry, needle: string): boolean {
  return (e.text ?? '').toLowerCase().includes(needle.toLowerCase());
}

function fieldMismatch(e: HistoryEntry, f: HistoryFilter): boolean {
  return (
    (!!f.line && e.line !== f.line) ||
    (!!f.station && e.station !== f.station) ||
    (!!f.from && e.from !== f.from)
  );
}

function matches(e: HistoryEntry, f: HistoryFilter): boolean {
  if (fieldMismatch(e, f)) return false;
  if (f.textContains && !textMatches(e, f.textContains)) return false;
  if (f.since && new Date(e.ts) < f.since) return false;
  return true;
}
