import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import { createHistory, historyFiles, type History } from '../src/history.ts';
import { HISTORY_LIMITS } from '../src/history-types.ts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const JID = '101@s.whatsapp.net';
const OTHER = '202@s.whatsapp.net';
let dir = '';
let previous: string | undefined;
let histories: History[] = [];

beforeEach(() => {
  setSystemTime(NOW);
  previous = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'wa-history-'));
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

function open(account = 'one'): History {
  const history = createHistory(account);
  histories.push(history);
  return history;
}

function message(id: string, ago = 10, jid = JID, text = id): WAMessage {
  return { key: { remoteJid: jid, id, fromMe: false }, messageTimestamp: NOW / 1000 - ago, message: { conversation: text } };
}

const ids = (history: History, jid = JID): string[] => history.read(jid, { limit: 100 }).messages.map((m) => m.messageId);

test('newest first with stable descending ID ties, exclusive before and inclusive since', () => {
  const history = open();
  history.ingest([message('old', 30), message('a', 10), message('middle', 20), message('z', 10)]);
  const first = history.read(JID, { limit: 2 });
  expect(first.messages.map((m) => m.messageId)).toEqual(['z', 'a']);
  expect(first.count).toBe(2);
  expect(first.hasMore).toBe(true);
  expect(first.nextBefore).toBe('a');
  const second = history.read(JID, { limit: 2, before: first.nextBefore, since: new Date(NOW - 20_000).toISOString() });
  expect(second.messages.map((m) => m.messageId)).toEqual(['middle']);
  expect(second.hasMore).toBe(false);
  expect(second.nextBefore).toBeUndefined();
  history.close();
  expect(open().read(JID, { before: 'z', limit: 1 }).messages[0]?.messageId).toBe('a');
});

test('an unknown, expired, or other-chat cursor fails instead of restarting pagination', () => {
  const history = open();
  history.ingest([message('a'), message('b', 10, OTHER)]);
  for (const before of ['missing', 'b']) expect(() => history.read(JID, { before })).toThrow('not retained in this chat');
  history.deleteMessages({ keys: [message('a').key] });
  expect(() => history.read(JID, { before: 'a' })).toThrow('not retained in this chat');
});

test('coverage stays explicitly partial even for an empty local chat and a full local page', () => {
  const history = open();
  const empty = history.read(JID);
  expect(empty).toMatchObject({ messages: [], count: 0, hasMore: false, coverage: { partial: true, source: 'local', oldest: null, newest: null, retained: 0 } });
  expect(empty.coverage.description).toContain('Gaps remain');
  history.ingest([message('one', 20), message('two', 10)]);
  const page = history.read(JID, { limit: 1 });
  expect(page.coverage).toMatchObject({ partial: true, retained: 2, limits: HISTORY_LIMITS, oldest: new Date(NOW - 20_000).toISOString(), newest: new Date(NOW - 10_000).toISOString() });
  expect(history.read(JID, { since: new Date(NOW).toISOString() }).coverage.retained).toBe(2);
});

test('limits are enforced and malformed paging inputs fail', () => {
  const history = open();
  history.ingest(Array.from({ length: 150 }, (_, i) => message(`m-${i}`, i + 1)));
  expect(history.read(JID).count).toBe(50);
  expect(history.read(JID, { limit: 1000 }).count).toBe(100);
  for (const limit of [0, -1, 1.5, Number.NaN, Infinity]) expect(() => history.read(JID, { limit })).toThrow();
  expect(() => history.read(JID, { since: 'not a date' })).toThrow();
});

test('chat and account keys do not leak even when message IDs repeat', () => {
  const one = open();
  const two = open('two');
  one.ingest([message('same', 10, JID, 'chat one'), message('same', 10, OTHER, 'chat two')]);
  two.ingest([message('same', 10, JID, 'account two')]);
  expect(one.read(JID).messages[0]?.text).toBe('chat one');
  expect(one.read(OTHER).messages[0]?.text).toBe('chat two');
  expect(two.read(JID).messages[0]?.text).toBe('account two');
  one.deleteMessages({ keys: [message('same').key] });
  expect(one.read(OTHER).count).toBe(1);
  expect(two.read(JID).count).toBe(1);
});

test('a colliding account-file name refuses another account rather than leaking its messages', () => {
  const history = open('one.dot');
  history.ingest([message('private')]);
  history.flush();
  expect(() => createHistory('one_dot')).toThrow('invalid');
});

test('own sends identify self, not recipient, including later identity enrichment', () => {
  const history = open();
  const own = { ...message('own'), key: { ...message('own').key, fromMe: true } };
  history.ingest([own]);
  expect(history.read(JID).messages[0]).toMatchObject({ fromMe: true });
  expect(history.read(JID).messages[0]?.senderJid).toBeUndefined();
  history.ingest([own], 'self:1@s.whatsapp.net');
  expect(history.read(JID).messages[0]?.senderJid).toBe('self:1@s.whatsapp.net');
  expect(history.read(JID).count).toBe(1);
});

test('group keys keep original participant and alternate identities verbatim across persistence', () => {
  const history = open();
  const key = { remoteJid: '123@g.us', id: 'group', fromMe: false, participant: '456@lid', participantAlt: '789@s.whatsapp.net', addressingMode: 'lid' };
  history.ingest([{ ...message('group'), key }]);
  expect(history.read(key.remoteJid).messages[0]?.senderJid).toBe(key.participant);
  history.close();
  const row = open().read(key.remoteJid).messages[0];
  expect(row?.key).toEqual(key);
  if (row) row.key.participant = 'changed@lid';
  expect(open('another').read(key.remoteJid).count).toBe(0);
});

test('caller mutation cannot alter a retained key, text, or metadata', () => {
  const history = open();
  const source = message('a');
  history.ingest([source]);
  source.key.id = 'changed';
  const row = history.read(JID).messages[0];
  if (row) { row.key.id = 'changed again'; row.text = 'changed'; }
  expect(ids(history)).toEqual(['a']);
  expect(history.read(JID).messages[0]?.text).toBe('a');
});

test('ordinary sync duplicates cannot overwrite later local edits, even after restart', () => {
  const history = open();
  history.ingest([message('a')]);
  history.edit(JID, 'a', 'edited');
  history.ingest([message('a', 1, JID, 'stale sync')]);
  expect(history.read(JID).messages[0]?.text).toBe('edited');
  expect(history.read(JID).messages[0]?.timestamp).toBe(new Date(NOW - 10_000).toISOString());
  history.close();
  const restored = open();
  restored.ingest([message('a')]);
  expect(restored.read(JID).messages[0]?.text).toBe('edited');
});

test('only bounded text and attachment metadata are persisted, with secure atomic files', () => {
  const history = open();
  history.ingest([{ ...message('media'), message: { imageMessage: { caption: 'caption', mimetype: 'image/jpeg', fileLength: 123, mediaKey: Buffer.from('MEDIA_SECRET'), url: 'https://private.invalid/content', directPath: '/secret/path', jpegThumbnail: Buffer.from('THUMBNAIL_SECRET'), contextInfo: { quotedMessage: { conversation: 'QUOTED_SECRET' } } } } }]);
  history.flush();
  const file = historyFiles.path('one');
  const body = readFileSync(file, 'utf8');
  expect(body).toContain('caption');
  for (const secret of ['MEDIA_SECRET', 'THUMBNAIL_SECRET', 'QUOTED_SECRET', 'private.invalid', '/secret/path', 'mediaKey', 'quotedMessage']) expect(body).not.toContain(secret);
  expect(history.read(JID).messages[0]?.attachments).toEqual([{ kind: 'image', mime: 'image/jpeg', name: 'image.jpg', bytes: 123 }]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(readdirSync(dir)).toEqual(['whatsapp-history-one.json']);
});

test('write failures are surfaced on flush and close and can be retried', () => {
  const history = open();
  history.ingest([message('a')]);
  const file = historyFiles.path('one');
  mkdirSync(file);
  expect(() => history.flush()).toThrow();
  expect(readdirSync(dir)).toEqual(['whatsapp-history-one.json']);
  expect(() => history.close()).toThrow();
  rmSync(file, { recursive: true });
  history.flush();
  expect(readFileSync(file, 'utf8')).toContain('a');
});

test('corrupt replay protection fails closed instead of pretending the store was empty', () => {
  writeFileSync(historyFiles.path('one'), '{not json');
  expect(() => createHistory('one')).toThrow();
  writeFileSync(historyFiles.path('one'), JSON.stringify({ version: 1, accountId: 'one', floor: 0, rows: [], tombstones: [['key', 'bad']], chatFloors: [] }));
  expect(() => createHistory('one')).toThrow('invalid');
});

test('closed stores cannot be changed or read', () => {
  const history = open();
  history.close();
  expect(() => history.ingest([message('a')])).toThrow('closed');
  expect(() => history.read(JID)).toThrow('closed');
});
