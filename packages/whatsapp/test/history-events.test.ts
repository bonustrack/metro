import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto, type WAMessage } from 'baileys';
import { createHistory, historyFiles, type History } from '../src/history.ts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const JID = '101@s.whatsapp.net';
const SELF = '999@s.whatsapp.net';
let dir = '';
let previous: string | undefined;
let histories: History[] = [];

beforeEach(() => {
  setSystemTime(NOW);
  previous = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'wa-history-events-'));
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

function message(id: string, content: proto.IMessage = { conversation: id }): WAMessage {
  return { key: { remoteJid: JID, id, fromMe: true }, messageTimestamp: NOW / 1000 - 60, message: content };
}

test('undated transport refresh preserves safe caption and metadata and never invents a new edit', () => {
  const history = open();
  const original = message('media', { imageMessage: { caption: 'caption', mimetype: 'image/jpeg', fileLength: 12 } });
  history.ingest([original], SELF);
  history.edit(JID, 'media', 'edited caption');
  const row = history.read(JID).messages[0];
  history.update([{ key: original.key, update: { message: { imageMessage: {
    url: 'https://example.invalid/transport-secret', directPath: '/transport-secret', mediaKey: Buffer.from('secret'), caption: 'stale caption', fileLength: 99,
  } } } }]);
  expect(history.read(JID).messages[0]).toEqual(row);
  history.close();
  expect(readFileSync(historyFiles.path('one'), 'utf8')).not.toContain('transport-secret');
  expect(open().read(JID).messages[0]).toEqual(row);
});

test('undated privacy changes still remove rows and block stripped replay', () => {
  const history = open();
  const originals = ['view', 'unknown', 'duration', 'null'].map((id) => message(id));
  history.ingest(originals);
  history.update([
    { key: originals[0]!.key, update: { message: { imageMessage: { viewOnce: true } } } },
    { key: originals[1]!.key, update: { message: { ephemeralMessage: { message: { conversation: 'secret' } } } } },
    { key: originals[2]!.key, update: { ephemeralDuration: 30, message: { conversation: 'secret' } } },
    { key: originals[3]!.key, update: { message: null } },
  ]);
  history.ingest(originals);
  expect(history.read(JID).count).toBe(0);
});

test('undated body updates neither create originals nor replace retained text', () => {
  const history = open();
  history.ingest([message('a')]);
  history.update([
    { key: message('a').key, update: { message: { conversation: 'undated edit' } } },
    { key: message('unknown').key, update: { message: { conversation: 'invented' } } },
  ]);
  expect(history.read(JID).messages.map((row) => row.text)).toEqual(['a']);
  history.ingest([message('unknown')]);
  expect(history.read(JID).count).toBe(2);
});

test('successful own sends with unknown expiry are omitted without blocking later observed sync', () => {
  const history = open();
  history.ingestSent([message('unknown'), { ...message('zero-envelope'), ephemeralDuration: 0 }], SELF);
  expect(history.read(JID).count).toBe(0);
  expect(history.read(JID).coverage.description).toContain('Own sends with unknown expiry');
  history.close();
  const restored = open();
  restored.ingest([message('unknown')], SELF);
  expect(restored.read(JID).messages[0]).toMatchObject({ text: 'unknown', fromMe: true, senderJid: SELF });
});

test('explicit positive own expiry is retained then expires from original time through restart', () => {
  const history = open();
  history.ingestSent([{ ...message('envelope'), ephemeralDuration: 90 }], SELF);
  history.ingestSent([message('known')], SELF, 90);
  expect(history.read(JID).count).toBe(2);
  history.close();
  setSystemTime(NOW + 31_000);
  const restored = open();
  expect(restored.read(JID).count).toBe(0);
  restored.ingest([message('envelope'), message('known')], SELF);
  expect(restored.read(JID).count).toBe(0);
});

test('authoritative non-expiring state allows own sends but never cancels an earlier explicit expiry', () => {
  const history = open();
  history.ingestSent([message('non-expiring')], SELF, 0);
  history.ingestSent([{ ...message('envelope'), ephemeralDuration: 90 }], SELF, 0);
  history.ingestSent([{ ...message('shorter'), ephemeralDuration: 3600 }], SELF, 90);
  history.ingestSent([message('context', { extendedTextMessage: { text: 'context', contextInfo: { expiration: 90 } } })], SELF, 3600);
  history.ingestSent([message('once', { viewOnceMessage: { message: { imageMessage: { caption: 'secret' } } } })], SELF, 0);
  expect(history.read(JID).count).toBe(4);
  setSystemTime(NOW + 31_000);
  expect(history.read(JID).messages.map((row) => row.messageId)).toEqual(['non-expiring']);
});

test('known non-expiring state cannot override unknown disappearing wrappers or incoming ownership', () => {
  const history = open();
  history.ingestSent([message('private', { ephemeralMessage: { message: { conversation: 'secret' } } })], SELF, 0);
  history.ingestSent([{ ...message('not-own'), key: { ...message('not-own').key, fromMe: false } }], SELF, 0);
  expect(history.read(JID).count).toBe(0);
});

test('known accepted own protocol edits and revokes apply without expiry metadata', () => {
  const history = open();
  const original = message('a');
  history.ingest([original], SELF);
  history.ingestSent([{
    ...message('edit'), messageTimestamp: NOW / 1000 - 1,
    message: { protocolMessage: { key: original.key, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, timestampMs: NOW - 1000, editedMessage: { conversation: 'edited' } } },
  }], SELF);
  expect(history.read(JID).messages[0]?.text).toBe('edited');
  history.ingestSent([{ ...message('delete'), message: { protocolMessage: { key: original.key, type: proto.Message.ProtocolMessage.Type.REVOKE } } }], SELF);
  expect(history.read(JID).count).toBe(0);
});

test('invalidating persists a disabled interval and next-open floor prevents crash-gap replay', () => {
  const history = open();
  history.ingest([message('before')]);
  history.invalidate();
  const disabled: { invalidated: boolean; rows: unknown[] } = JSON.parse(readFileSync(historyFiles.path('one'), 'utf8'));
  expect(disabled.invalidated).toBe(true);
  expect(disabled.rows).toEqual([]);
  history.close();
  setSystemTime(NOW + 3600_000);
  const restored = open();
  const during = { ...message('during-gap'), messageTimestamp: NOW / 1000 + 1800 };
  restored.ingest([message('before'), during]);
  expect(restored.read(JID).count).toBe(0);
  expect(Date.parse(restored.read(JID).coverage.retainedAfter)).toBe(NOW + 3600_000);
  setSystemTime(NOW + 3601_000);
  restored.ingest([{ ...message('after'), messageTimestamp: NOW / 1000 + 3601 }]);
  expect(restored.read(JID).messages[0]?.messageId).toBe('after');
  restored.close();
  const again = open();
  expect(again.read(JID).messages[0]?.messageId).toBe('after');
  expect(readFileSync(historyFiles.path('one'), 'utf8')).not.toContain('invalidated');
});
