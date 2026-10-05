import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto, WAMessageStubType, type WAMessage } from 'baileys';
import { createHistory, historyFiles, type History } from '../src/history.ts';
import { HISTORY_SWEEP_MS } from '../src/history-types.ts';
import { log } from '@metro-labs/core/log';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const JID = '101@s.whatsapp.net';
let dir = '';
let previous: string | undefined;
let histories: History[] = [];

beforeEach(() => {
  setSystemTime(NOW);
  previous = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'wa-history-privacy-'));
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

function message(id: string, content: proto.IMessage = { conversation: id }, ago = 60): WAMessage {
  return { key: { remoteJid: JID, id, fromMe: false }, messageTimestamp: NOW / 1000 - ago, message: content };
}

function protocol(id: string, type: proto.Message.ProtocolMessage.Type, text?: string, revision = NOW - 2000): WAMessage {
  return message('protocol', { protocolMessage: { key: message(id).key, type, ...(text === undefined ? {} : { editedMessage: { conversation: text } }), timestampMs: revision } }, 2);
}

test('view-once wrappers, node flags and key flags never retain content or resurrect through ordinary replay', () => {
  const history = open();
  const once = { imageMessage: { caption: 'secret' } };
  const messages = [
    message('v1', { viewOnceMessage: { message: once } }),
    message('v2', { deviceSentMessage: { message: { viewOnceMessageV2: { message: once } } } }),
    message('v3', { viewOnceMessageV2Extension: { message: once } }),
    message('node', { videoMessage: { caption: 'secret', viewOnce: true } }),
    { ...message('key', once), key: { ...message('key').key, isViewOnce: true } },
  ];
  history.ingest(messages);
  history.ingest(messages.map((m) => ({ ...m, key: { ...m.key, isViewOnce: false }, message: { conversation: 'replayed secret' } })));
  expect(history.read(JID).count).toBe(0);
  history.flush();
  expect(readFileSync(historyFiles.path('one'), 'utf8')).not.toContain('secret');
});

test('ephemeral messages without a safe expiration are omitted, including nested wrappers', () => {
  const history = open();
  history.ingest([
    message('unknown', { ephemeralMessage: { message: { conversation: 'secret' } } }),
    message('negative', { extendedTextMessage: { text: 'secret', contextInfo: { expiration: -1 } } }),
    message('mode', { extendedTextMessage: { text: 'secret', contextInfo: { disappearingMode: {} } } }),
    { ...message('duration'), ephemeralStartTimestamp: NOW / 1000 - 30 },
    message('deep', { deviceSentMessage: { message: { ephemeralMessage: { message: { conversation: 'secret' } } } } }),
  ]);
  expect(history.read(JID).count).toBe(0);
  history.ingest([message('unknown')]);
  expect(history.read(JID).count).toBe(0);
});

test('safe expiration uses original message time, never sync time, and replay cannot resurrect it', () => {
  const history = open();
  const expiring = message('expiring', { ephemeralMessage: { message: { extendedTextMessage: { text: 'temporary', contextInfo: { expiration: 90 } } } } });
  history.ingest([expiring]);
  expect(history.read(JID).messages[0]?.text).toBe('temporary');
  setSystemTime(NOW + 31_000);
  expect(history.read(JID).count).toBe(0);
  history.ingest([message('expiring', { conversation: 'stripped expiry' })]);
  expect(history.read(JID).count).toBe(0);
  history.close();
  const restored = open();
  restored.ingest([expiring]);
  expect(restored.read(JID).count).toBe(0);
});

test('expiration is shortened by duplicate metadata but never extended by edits or later sync', () => {
  const history = open();
  history.ingest([{ ...message('a'), ephemeralDuration: 90 }]);
  history.ingest([{ ...message('a'), ephemeralDuration: 3600 }]);
  history.edit(JID, 'a', 'still temporary');
  setSystemTime(NOW + 31_000);
  expect(history.read(JID).count).toBe(0);
  const second = message('b', { conversation: 'b' }, 10);
  history.ingest([{ ...second, ephemeralDuration: 100 }]);
  history.ingest([{ ...second, ephemeralDuration: 20 }]);
  expect(history.read(JID).count).toBe(0);
});

test('idle sweep expires and persists messages without a read, and closes its timer', () => {
  const intervals = spyOn(globalThis, 'setInterval');
  const clears = spyOn(globalThis, 'clearInterval');
  try {
    const history = open();
    history.ingest([{ ...message('temporary'), ephemeralDuration: 90 }]);
    history.flush();
    const call = intervals.mock.calls.find((args) => args[1] === HISTORY_SWEEP_MS);
    expect(call).toBeDefined();
    setSystemTime(NOW + 31_000);
    if (typeof call?.[0] === 'function') call[0]();
    expect(readFileSync(historyFiles.path('one'), 'utf8')).not.toContain('"text":"temporary"');
    history.close();
    expect(clears).toHaveBeenCalled();
  } finally {
    intervals.mockRestore();
    clears.mockRestore();
  }
});

test('idle save failures are logged and the next flush can retry', () => {
  const intervals = spyOn(globalThis, 'setInterval');
  const errors = spyOn(log, 'error').mockReturnValue(undefined);
  const history = open();
  const file = historyFiles.path('one');
  try {
    history.ingest([message('a')]);
    mkdirSync(file);
    const call = intervals.mock.calls.find((args) => args[1] === HISTORY_SWEEP_MS);
    if (typeof call?.[0] === 'function') call[0]();
    expect(errors).toHaveBeenCalled();
  } finally {
    rmSync(file, { recursive: true, force: true });
    intervals.mockRestore();
    errors.mockRestore();
  }
  history.flush();
  expect(readFileSync(file, 'utf8')).toContain('"text":"a"');
});

test('WAMessageUpdate null and REVOKE stubs delete and remain deleted after replay and restart', () => {
  const history = open();
  history.ingest([message('null'), message('stub')]);
  history.update([{ key: message('null').key, update: { message: null } }, { key: message('stub').key, update: { messageStubType: WAMessageStubType.REVOKE } }]);
  history.close();
  const restored = open();
  restored.ingest([message('null'), message('stub')]);
  expect(restored.read(JID).count).toBe(0);
});

test('protocol revoke applies to its original target, not the protocol envelope ID', () => {
  const history = open();
  history.ingest([message('a'), message('b')]);
  history.ingest([protocol('a', proto.Message.ProtocolMessage.Type.REVOKE)]);
  history.ingest([message('a')]);
  expect(history.read(JID).messages.map((m) => m.messageId)).toEqual(['b']);
});

test('protocol edits and edited-message updates preserve original ordering and reject older edits', () => {
  const history = open();
  history.ingest([message('a')]);
  history.ingest([protocol('a', proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, 'edit one', NOW - 4000)]);
  expect(history.read(JID).messages[0]?.text).toBe('edit one');
  history.update([{ key: message('a').key, update: { message: { editedMessage: { message: { conversation: 'edit two' } } }, messageTimestamp: NOW / 1000 - 1 } }]);
  history.ingest([protocol('a', proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, 'old edit', NOW - 3000), message('a')]);
  const row = history.read(JID).messages[0];
  expect(row?.text).toBe('edit two');
  expect(row?.timestamp).toBe(new Date(NOW - 60_000).toISOString());
  expect(row?.key).toEqual(message('a').key);
});

test('caption edits keep safe attachment metadata, self identity, and the earlier expiry', () => {
  const history = open();
  const key = { ...message('media').key, fromMe: true };
  history.ingest([{ ...message('media', { imageMessage: { caption: 'original' } }), key, ephemeralDuration: 90 }], 'self@s.whatsapp.net');
  history.update([{ key, update: { message: { editedMessage: { message: { conversation: 'edited caption' } } }, messageTimestamp: NOW / 1000 - 1 } }]);
  expect(history.read(JID).messages[0]).toMatchObject({ text: 'edited caption', senderJid: 'self@s.whatsapp.net', attachments: [{ kind: 'image' }] });
  setSystemTime(NOW + 31_000);
  expect(history.read(JID).count).toBe(0);
});

test('unknown-target edits and local deletes block later stale sync rather than inventing originals', () => {
  const history = open();
  history.ingest([protocol('unknown', proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, 'changed')]);
  history.edit(JID, 'local-edit', 'changed');
  history.deleteMessages({ keys: [message('deleted').key] });
  history.ingest([message('unknown'), message('local-edit'), message('deleted')]);
  expect(history.read(JID).count).toBe(0);
});

test('chat clear deletes only that chat and its replay floor survives a restart', () => {
  const history = open();
  history.ingest([message('a'), { ...message('b'), key: { remoteJid: 'other@lid', id: 'b' } }]);
  history.deleteMessages({ jid: JID, all: true });
  history.close();
  const restored = open();
  restored.ingest([message('a')]);
  expect(restored.read(JID).count).toBe(0);
  expect(restored.read('other@lid').count).toBe(1);
  setSystemTime(NOW + 1000);
  restored.ingest([{ ...message('new'), messageTimestamp: (NOW + 1000) / 1000 }]);
  expect(restored.read(JID).messages[0]?.messageId).toBe('new');
});

test('receipts and status-only updates do not become history or erase a body', () => {
  const history = open();
  history.ingest([message('a'), message('react', { reactionMessage: { key: message('a').key, text: '+' } })]);
  history.update([{ key: message('a').key, update: { status: proto.WebMessageInfo.Status.READ } }]);
  expect(history.read(JID).messages.map((m) => m.text)).toEqual(['a']);
});

test('absent-body placeholders do not tombstone later decrypted upserts, even across restart', () => {
  const history = open();
  for (const body of [undefined, null])
    history.ingest([{ ...message(String(body)), message: body, messageStubType: WAMessageStubType.CIPHERTEXT }]);
  history.close();
  const restored = open();
  restored.ingest([message('undefined'), message('null')]);
  expect(restored.read(JID).messages.map((row) => row.text)).toEqual(['undefined', 'null']);
  restored.ingest([{ ...message('undefined'), message: undefined }]);
  expect(restored.read(JID).count).toBe(2);
  restored.update([{ key: message('null').key, update: { message: null } }]);
  restored.ingest([message('null')]);
  expect(restored.read(JID).messages.map((row) => row.text)).toEqual(['undefined']);
});

test('over-depth wrappers stay forbidden and prevent stripped-body replay', () => {
  const history = open();
  let body: proto.IMessage = { conversation: 'secret' };
  for (let depth = 0; depth < 13; depth++) body = { deviceSentMessage: { message: body } };
  history.ingest([message('deep', body)]);
  history.ingest([message('deep')]);
  expect(history.read(JID).count).toBe(0);
});

test('missing, invalid or future timestamps are not replaced with ingestion time', () => {
  const history = open();
  for (const timestamp of [undefined, null, 0, -1, NaN, Infinity, NOW / 1000 + 1, NOW / 1000 - 0.0001])
    history.ingest([{ ...message(String(timestamp)), messageTimestamp: timestamp }]);
  expect(history.read(JID).count).toBe(0);
});
