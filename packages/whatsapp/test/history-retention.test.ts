import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import { createHistory, historyFiles, type History } from '../src/history.ts';
import { HISTORY_AGE_MS, HISTORY_LIMITS } from '../src/history-types.ts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const JID = '101@s.whatsapp.net';
let dir = '';
let previous: string | undefined;
let histories: History[] = [];

beforeEach(() => {
  setSystemTime(NOW);
  previous = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'wa-history-retention-'));
  process.env.WHATSAPP_TOKEN_DIR = dir;
  histories = [];
});

afterEach(() => {
  for (const history of histories) history.close();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = previous;
  setSystemTime();
});

function open(): History {
  const history = createHistory('one');
  histories.push(history);
  return history;
}

function message(id: string, ago = 10, jid = JID, text = id): WAMessage {
  return { key: { remoteJid: jid, id, fromMe: false }, messageTimestamp: NOW / 1000 - ago, message: { conversation: text } };
}

test('UTF-8 text and captions are capped without splitting a character', () => {
  const history = open();
  const source = '界'.repeat(HISTORY_LIMITS.textBytes);
  history.ingest([message('long', 10, JID, source), { ...message('caption'), message: { imageMessage: { caption: source } } }]);
  for (const row of history.read(JID).messages) {
    expect(Buffer.byteLength(row.text)).toBeLessThanOrEqual(HISTORY_LIMITS.textBytes);
    expect(row.truncated).toBe(true);
    expect(source.startsWith(row.text)).toBe(true);
    expect(row.text).not.toContain('�');
  }
});

test('per-chat row cap advances only that chat floor and cannot be undone by replay', () => {
  const history = open();
  const input = Array.from({ length: HISTORY_LIMITS.rowsPerChat + 1 }, (_, i) => message(`m-${i}`, i + 1));
  history.ingest([...input, message('other', 10_000, 'other@lid')]);
  const page = history.read(JID);
  expect(page.coverage.retained).toBe(HISTORY_LIMITS.rowsPerChat);
  expect(page.coverage.retainedAfter).toBe(new Date(NOW - (HISTORY_LIMITS.rowsPerChat + 1) * 1000).toISOString());
  expect(history.read('other@lid').count).toBe(1);
  history.close();
  const restored = open();
  restored.ingest([input.at(-1)!]);
  expect(restored.read(JID).coverage.retained).toBe(HISTORY_LIMITS.rowsPerChat);
});

test('account row cap applies across chats and retained counts sum to the advertised bound', () => {
  const history = open();
  history.ingest(Array.from({ length: HISTORY_LIMITS.rows + 5 }, (_, i) => message(`m-${i}`, i + 1, `${i % 20}@lid`)));
  const retained = Array.from({ length: 20 }, (_, i) => history.read(`${i}@lid`).coverage.retained).reduce((a, b) => a + b, 0);
  expect(retained).toBe(HISTORY_LIMITS.rows);
});

test('serialized byte cap includes escaping, metadata and replay markers, not just text lengths', () => {
  const history = open();
  const text = '\n'.repeat(HISTORY_LIMITS.textBytes);
  history.ingest(Array.from({ length: 600 }, (_, i) => message(`m-${i}`, i + 1, `${i % 3}@lid`, text)));
  history.flush();
  expect(statSync(historyFiles.path('one')).size).toBeLessThanOrEqual(HISTORY_LIMITS.bytes);
  const retained = [0, 1, 2].map((i) => history.read(`${i}@lid`).coverage.retained).reduce((a, b) => a + b, 0);
  expect(retained).toBeLessThan(600);
  expect(retained).toBeGreaterThan(0);
  history.close();
  expect(open().read('0@lid').coverage.partial).toBe(true);
});

test('escaped-text pages stay within serialized byte limits and advance without losing messages', () => {
  const history = open();
  const text = '\u0000'.repeat(HISTORY_LIMITS.textBytes);
  const input = Array.from({ length: 64 }, (_, i) => message(`m-${i}`, i + 1, JID, text));
  history.ingest(input);
  const ids: string[] = [];
  let before: string | undefined;
  for (let i = 0; i < input.length; i++) {
    const page = history.read(JID, { limit: HISTORY_LIMITS.pageSize, before });
    expect(page.count).toBeGreaterThan(0);
    expect(page.count).toBe(page.messages.length);
    expect(page.count).toBeLessThan(input.length);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(HISTORY_LIMITS.pageBytes);
    expect(page.coverage.limits.pageBytes).toBe(HISTORY_LIMITS.pageBytes);
    expect(page.coverage.partial).toBe(true);
    ids.push(...page.messages.map((row) => row.messageId));
    expect(page.hasMore).toBe(ids.length < input.length);
    if (!page.hasMore) {
      expect(page.nextBefore).toBeUndefined();
      break;
    }
    expect(page.nextBefore).toBe(page.messages.at(-1)?.messageId);
    expect(page.nextBefore).not.toBe(before);
    before = page.nextBefore;
  }
  expect(ids).toEqual(input.map((row) => row.key.id));
  const since = new Date(NOW - 45_000).toISOString();
  const first = history.read(JID, { limit: 100, since });
  const second = history.read(JID, { limit: 100, since, before: first.nextBefore });
  const last = history.read(JID, { limit: 100, since, before: second.nextBefore });
  expect([...first.messages, ...second.messages, ...last.messages].map((row) => row.messageId)).toEqual(input.slice(0, 45).map((row) => row.key.id));
  expect(last.hasMore).toBe(false);
  expect(history.read(JID, { limit: 1, since }).messages.map((row) => row.messageId)).toEqual(['m-0']);
});

test('retention age is pruned on ingestion, read, and startup without admitting expired replay', () => {
  const history = open();
  history.ingest([message('too-old', HISTORY_AGE_MS / 1000 + 1), message('retained', HISTORY_AGE_MS / 1000 - 1)]);
  expect(history.read(JID).messages.map((m) => m.messageId)).toEqual(['retained']);
  history.close();
  setSystemTime(NOW + 2000);
  const restored = open();
  expect(restored.read(JID).count).toBe(0);
  restored.ingest([message('retained', HISTORY_AGE_MS / 1000 - 1)]);
  expect(restored.read(JID).count).toBe(0);
});

test('tombstone eviction advances a durable floor so old sync cannot resurrect deleted content', () => {
  const history = open();
  const deleted = message('deleted');
  history.ingest([deleted]);
  history.deleteMessages({ keys: [deleted.key, ...Array.from({ length: HISTORY_LIMITS.tombstones }, (_, i) => message(`unknown-${i}`).key)] });
  history.ingest([deleted]);
  expect(history.read(JID).count).toBe(0);
  expect(Date.parse(history.read(JID).coverage.retainedAfter)).toBeGreaterThanOrEqual(NOW);
  history.close();
  const restored = open();
  restored.ingest([deleted]);
  expect(restored.read(JID).count).toBe(0);
  setSystemTime(NOW + 1000);
  restored.ingest([{ ...message('new'), messageTimestamp: (NOW + 1000) / 1000 }]);
  expect(restored.read(JID).messages[0]?.messageId).toBe('new');
});

test('evicting a chat-clear marker also advances the durable account floor', () => {
  const history = open();
  history.ingest([message('deleted')]);
  history.deleteMessages({ jid: JID, all: true });
  for (let i = 0; i < HISTORY_LIMITS.chatFloors; i++) history.deleteMessages({ jid: `${i}@lid`, all: true });
  history.ingest([message('deleted')]);
  expect(history.read(JID).count).toBe(0);
  history.close();
  const restored = open();
  restored.ingest([message('deleted')]);
  expect(restored.read(JID).count).toBe(0);
});

test('retention eviction does not bring back a row with a locally edited body', () => {
  const history = open();
  history.ingest([message('old', HISTORY_LIMITS.rowsPerChat + 100)]);
  history.edit(JID, 'old', 'edited');
  history.ingest(Array.from({ length: HISTORY_LIMITS.rowsPerChat }, (_, i) => message(`new-${i}`, i + 1)));
  history.ingest([message('old', HISTORY_LIMITS.rowsPerChat + 100)]);
  expect(() => history.read(JID, { before: 'old' })).toThrow('not retained');
  history.flush();
  expect(readFileSync(historyFiles.path('one'), 'utf8')).not.toContain('"text":"old"');
});
