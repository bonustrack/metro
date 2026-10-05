import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto, type WAMessage, type WAMessageKey } from 'baileys';
import { createHistory, historyFiles, type History } from '../src/history.ts';
import { HISTORY_LIMITS } from '../src/history-types.ts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const PN = '101@s.whatsapp.net';
const LID = '901@lid';
const GROUP = '123@g.us';
let dir = '';
let previous: string | undefined;
let histories: History[] = [];

beforeEach(() => {
  setSystemTime(NOW);
  previous = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'wa-history-identity-'));
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

function message(id: string, key: Partial<WAMessageKey> = {}, ago = 60): WAMessage {
  return { key: { remoteJid: PN, id, fromMe: false, ...key }, messageTimestamp: NOW / 1000 - ago, message: { conversation: id } };
}

function edit(target: WAMessageKey, editor: WAMessageKey, text: string): WAMessage {
  return {
    key: editor, messageTimestamp: NOW / 1000 - 1,
    message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: target, editedMessage: { conversation: text }, timestampMs: NOW - 1000 } },
  };
}

test('original key aliases unify reads and deletion markers through alternate replay and restart', () => {
  const history = open();
  const original = message('a', { remoteJidAlt: LID });
  history.ingest([original]);
  expect(history.read(LID).messages[0]?.key).toEqual(original.key);
  history.deleteMessages({ keys: [{ remoteJid: LID, id: 'a' }] });
  history.close();
  const restored = open();
  restored.ingest([message('a'), message('a', { remoteJid: LID })]);
  expect(restored.read(PN).count).toBe(0);
  expect(restored.read(LID).count).toBe(0);
});

test('mapping learned after deletion removes aliases already retained and stays account-local', () => {
  const history = open();
  const other = open('other');
  history.ingest([message('a')]);
  other.ingest([message('a')]);
  history.deleteMessages({ keys: [{ remoteJid: LID, id: 'a' }] });
  history.alias(PN, LID);
  expect(history.read(PN).count).toBe(0);
  expect(other.read(PN).count).toBe(1);
  expect(other.read(LID).count).toBe(0);
  history.close();
  const restored = open();
  restored.ingest([message('a')]);
  expect(restored.read(PN).count).toBe(0);
});

test('alias dedup preserves newer edits and the original key instead of stale sync', () => {
  const history = open();
  const original = message('a', { remoteJidAlt: LID });
  history.ingest([original]);
  history.edit(LID, 'a', 'edited');
  history.ingest([message('a', { remoteJid: LID })]);
  expect(history.read(PN).messages).toHaveLength(1);
  expect(history.read(LID).messages[0]).toMatchObject({ key: original.key, text: 'edited' });
  history.close();
  const restored = open();
  restored.ingest([message('a', { remoteJid: LID })]);
  expect(restored.read(PN).messages[0]?.text).toBe('edited');
});

test('late aliases merge duplicate rows using the newest edit and shortest expiration', () => {
  const history = open();
  history.ingest([message('a'), { ...message('a', { remoteJid: LID }), ephemeralDuration: 90 }]);
  history.edit(PN, 'a', 'edited');
  history.alias(PN, LID);
  expect(history.read(LID).count).toBe(1);
  expect(history.read(LID).messages[0]?.text).toBe('edited');
  setSystemTime(NOW + 31_000);
  expect(history.read(PN).count).toBe(0);
});

test('chat clears cover known aliases and mappings learned after the clear', () => {
  const history = open();
  history.ingest([message('a')]);
  history.deleteMessages({ jid: LID, all: true });
  history.alias(PN, LID);
  expect(history.read(PN).count).toBe(0);
  history.close();
  const restored = open();
  restored.ingest([message('a', { remoteJid: LID }), message('a')]);
  expect(restored.read(LID).count).toBe(0);
});

test('aliases normalize device-qualified identities and do not alias unrelated groups', () => {
  const history = open();
  history.ingest([message('a', { remoteJid: '101:7@s.whatsapp.net', remoteJidAlt: LID })]);
  expect(history.read(PN).count).toBe(1);
  history.deleteMessages({ keys: [{ remoteJid: LID, id: 'a' }] });
  expect(history.read(PN).count).toBe(0);
  history.alias(GROUP, 'other@g.us');
  history.ingest([message('group', { remoteJid: GROUP })]);
  expect(history.read('other@g.us').count).toBe(0);
});

test('group protocol and update edits require the original author, never the claimed target author', () => {
  const history = open();
  const original = message('a', { remoteJid: GROUP, participant: PN, participantAlt: LID });
  history.ingest([original]);
  const stranger = { ...original.key, id: 'edit', participant: '202@s.whatsapp.net', participantAlt: undefined };
  history.ingest([edit(original.key, stranger, 'forged')]);
  history.update([{ key: stranger, update: { message: edit(original.key, stranger, 'forged update').message } }]);
  history.update([{ key: { ...stranger, id: 'a' }, update: { message: { conversation: 'forged dated' }, messageTimestamp: NOW / 1000 - 1 } }]);
  expect(history.read(GROUP).messages[0]?.text).toBe('a');
  const editor = { ...original.key, id: 'edit', participant: LID, participantAlt: PN };
  history.ingest([edit(original.key, editor, 'authorized')]);
  expect(history.read(GROUP).messages[0]).toMatchObject({ key: original.key, text: 'authorized' });
});

test('fromMe mismatch and unknown group authors cannot edit even through alias keys', () => {
  const history = open();
  const original = message('a', { remoteJid: GROUP, participant: PN });
  history.ingest([original]);
  for (const key of [{ ...original.key, fromMe: true }, { ...original.key, participant: undefined }])
    history.ingest([edit(original.key, { ...key, id: 'edit' }, 'forged')]);
  expect(history.read(GROUP).messages[0]?.text).toBe('a');
  history.alias(PN, LID);
  history.update([{ key: { ...original.key, participant: LID }, update: { message: { conversation: 'valid' }, messageTimestamp: NOW / 1000 - 1 } }]);
  expect(history.read(GROUP).messages[0]?.text).toBe('valid');
});

test('ranged clears use user cutoff and scoped explicit keys, preserve newer unrelated rows and survive restart', () => {
  const history = open();
  history.alias(PN, LID);
  history.ingest([message('old', {}, 100), message('new', {}, 5), message('explicit', {}, 4), message('other', { remoteJid: 'other@lid' }, 100)]);
  history.clearRange(LID, {
    lastMessageTimestamp: NOW / 1000 - 50,
    lastSystemMessageTimestamp: NOW / 1000,
    messages: [{ key: { remoteJid: LID, id: 'explicit' }, timestamp: NOW / 1000 - 4 }, { key: message('other', { remoteJid: 'other@lid' }).key }],
  });
  expect(history.read(PN).messages.map((row) => row.messageId)).toEqual(['new']);
  expect(history.read('other@lid').count).toBe(1);
  history.close();
  const restored = open();
  restored.ingest([message('old', { remoteJid: LID }, 100), message('explicit', {}, 4)]);
  expect(restored.read(LID).messages.map((row) => row.messageId)).toEqual(['new']);
});

test('empty and system-only ranges refuse affected reads without guessing a cutoff or erasing newer rows', () => {
  const history = open();
  history.ingest([message('a'), message('other', { remoteJid: 'other@lid' })]);
  history.clearRange(PN, {});
  history.clearRange(PN, { lastSystemMessageTimestamp: NOW / 1000 });
  history.clearRange(PN, { lastMessageTimestamp: NOW / 1000 + 1 });
  expect(() => history.read(PN)).toThrow('chat deletion had no safe message range');
  expect(history.read('other@lid').count).toBe(1);
  history.close();
  expect(readFileSync(historyFiles.path('one'), 'utf8')).toContain('"text":"a"');
  const restored = open();
  restored.alias(PN, LID);
  expect(() => restored.read(LID)).toThrow('chat deletion had no safe message range');
  expect(restored.read('other@lid').count).toBe(1);
  expect(open('other-account').read(PN).count).toBe(0);
});

test('scoped explicit keys are a usable range even without a cutoff', () => {
  const history = open();
  history.ingest([message('a'), message('new', {}, 1)]);
  history.clearRange(PN, { messages: [{ key: { id: 'a' } }] });
  expect(history.read(PN).messages.map((row) => row.messageId)).toEqual(['new']);
});

test('missing and malformed ranges fail closed per chat and markers survive reopen', () => {
  const history = open();
  history.clearRange(PN);
  history.clearRange('null@lid', null);
  history.clearRange('negative@lid', { lastMessageTimestamp: -1 });
  history.clearRange('unrelated@lid', { messages: [{ key: message('a').key }] });
  history.close();
  const restored = open();
  for (const jid of [PN, 'null@lid', 'negative@lid', 'unrelated@lid'])
    expect(() => restored.read(jid)).toThrow('chat deletion had no safe message range');
  expect(restored.read('safe@lid').count).toBe(0);
});

test('unavailable marker overflow stays bounded and fails closed without deleting other-chat rows', () => {
  const history = open();
  history.ingest([message('a')]);
  for (let i = 0; i <= HISTORY_LIMITS.unavailableChats; i++) history.clearRange(`${i}@lid`, {});
  history.close();
  const disk: { unavailableChats: string[]; unavailableOverflow: boolean; rows: unknown[] } = JSON.parse(readFileSync(historyFiles.path('one'), 'utf8'));
  expect(disk.unavailableChats.length).toBeLessThanOrEqual(HISTORY_LIMITS.unavailableChats);
  expect(disk.unavailableOverflow).toBe(true);
  expect(disk.rows).toHaveLength(1);
  expect(() => open().read(PN)).toThrow('chat deletion had no safe message range');
});

test('per-chat retention cap counts both authoritative aliases together', () => {
  const history = open();
  history.alias(PN, LID);
  history.ingest(Array.from({ length: HISTORY_LIMITS.rowsPerChat + 1 }, (_, i) => message(`a-${i}`, { remoteJid: i % 2 ? LID : PN }, i + 1)));
  expect(history.read(PN).coverage.retained).toBe(HISTORY_LIMITS.rowsPerChat);
  expect(history.read(LID).coverage.retained).toBe(HISTORY_LIMITS.rowsPerChat);
});

test('bounded alias eviction advances a durable floor before forgetting replay identity', () => {
  const history = open();
  history.ingest([message('a', { remoteJidAlt: LID })]);
  history.deleteMessages({ keys: [{ remoteJid: LID, id: 'a' }] });
  for (let i = 0; i < HISTORY_LIMITS.aliases / 2; i++) history.alias(`${1000 + i}@s.whatsapp.net`, `${1000 + i}@lid`);
  history.close();
  const disk: { aliases: string[][] } = JSON.parse(readFileSync(historyFiles.path('one'), 'utf8'));
  expect(disk.aliases.flat().length).toBeLessThanOrEqual(HISTORY_LIMITS.aliases);
  const restored = open();
  restored.ingest([message('a'), message('a', { remoteJid: LID })]);
  expect(restored.read(PN).count).toBe(0);
  expect(restored.read(LID).count).toBe(0);
});
