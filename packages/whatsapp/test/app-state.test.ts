import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chatModificationToAppPatch, decodePatches, encodeSyncdPatch, makeEventBuffer,
  newLTHashState, processSyncAction, proto, type BaileysEventMap, type ChatModification, type ChatMutation, type WAMessage,
} from 'baileys';
import { supportsHistoryDeletion } from '../src/app-state.js';
import { createHistory, type History } from '../src/history.js';
import { makeKeyCache } from '../src/keys.js';
import { baileysLogger } from '../src/logger.js';
import { bindMessages } from '../src/messages.js';
import { makeNameBook } from '../src/names.js';

const JID = '123@g.us';
const SELF = '447700900111@s.whatsapp.net';
const OTHER = '222@lid';
const logger = baileysLogger('app-state-fixture');
const cases = [
  { action: 'clear', initial: false }, { action: 'clear', initial: true },
  { action: 'delete', initial: false }, { action: 'delete', initial: true },
] as const;
type Range = proto.SyncActionValue.ISyncActionMessageRange;

function message(id: string, timestamp: number): WAMessage {
  return {
    key: { id, remoteJid: JID, participant: OTHER, fromMe: false },
    messageTimestamp: timestamp, message: { conversation: `fixture ${id}` },
  };
}

async function authenticatedMutation(action: 'clear' | 'delete', range?: Range): Promise<ChatMutation> {
  const modification: ChatModification = action === 'clear' ? { clear: true, lastMessages: range ?? {} } : { delete: true, lastMessages: range ?? {} };
  const patch = chatModificationToAppPatch(modification, JID);
  if (range === undefined) {
    if (patch.syncAction.clearChatAction) patch.syncAction.clearChatAction.messageRange = undefined;
    if (patch.syncAction.deleteChatAction) patch.syncAction.deleteChatAction.messageRange = undefined;
  }
  const keyId = Buffer.from('fixture-app-state-key').toString('base64');
  const key = proto.Message.AppStateSyncKeyData.create({ keyData: Buffer.alloc(32, 7) });
  const getKey = async (id: string): Promise<proto.Message.IAppStateSyncKeyData | null> => id === keyId ? key : null;
  const encoded = await encodeSyncdPatch(patch, keyId, newLTHashState(), getKey);
  const wire = proto.SyncdPatch.encode({ ...encoded.patch, version: { version: encoded.state.version } }).finish();
  const decoded = await decodePatches(patch.type, [proto.SyncdPatch.decode(wire)], newLTHashState(), getKey, {}, undefined, logger, true);
  const mutations = Object.values(decoded.mutationMap);
  expect(mutations).toHaveLength(1);
  const mutation = mutations[0];
  if (!mutation) throw new Error('SDK did not decode the fixture mutation');
  return mutation;
}

function apply(mutation: ChatMutation, ev: ReturnType<typeof makeEventBuffer>, initial: boolean): void {
  processSyncAction(mutation, ev, { id: SELF }, initial ? { accountSettings: { unarchiveChats: false } } : undefined, logger);
}

describe('pinned Baileys authenticated app-state deletion', () => {
  let dir: string;
  let previous: string | undefined;
  let history: History;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metro-wa-app-state-'));
    previous = process.env.WHATSAPP_TOKEN_DIR;
    process.env.WHATSAPP_TOKEN_DIR = dir;
    history = createHistory('fixture');
  });

  afterEach(() => {
    history.close();
    if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
    else process.env.WHATSAPP_TOKEN_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(): {
    ev: ReturnType<typeof makeEventBuffer>;
    incoming: WAMessage[];
    keys: ReturnType<typeof makeKeyCache>;
    retire(): void;
  } {
    const ev = makeEventBuffer(logger);
    const incoming: WAMessage[] = [];
    const keys = makeKeyCache();
    let current = true;
    bindMessages({ ev, user: { id: SELF } }, {
      accountId: 'fixture', history, keys, names: makeNameBook(),
      current: () => current,
      self: () => ({ jids: new Set([SELF]), sentByMe: () => false }),
      handlers: () => ({ onMessage: (_, raw) => incoming.push(raw), onReaction: () => undefined }),
    });
    return { ev, incoming, keys, retire: () => { current = false; } };
  }

  test.each(cases)('$action, initial=$initial: emits one original range and preserves newer history', async ({ action, initial }) => {
    const f = fixture();
    const now = Math.floor(Date.now() / 1000);
    const old = message('old', now - 60);
    const newer = message('newer', now - 40);
    const selected = message('selected', now - 10);
    const range = {
      lastMessageTimestamp: now - 60, lastSystemMessageTimestamp: now - 20,
      messages: [{ key: old.key, timestamp: now - 60 }, { key: selected.key, timestamp: now - 10 }],
    };
    f.ev.emit('messages.upsert', { messages: [old, newer, selected], type: 'append' });
    const mutation = await authenticatedMutation(action, range);
    const decodedRange = mutation.syncAction.value?.clearChatAction?.messageRange ?? mutation.syncAction.value?.deleteChatAction?.messageRange;
    const clears: BaileysEventMap['chats.clear'][] = [];
    const deletes: string[][] = [];
    f.ev.on('chats.clear', (event) => { clears.push(event); });
    f.ev.on('chats.delete', (event) => { deletes.push(event); });
    f.ev.buffer();
    f.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [old] });
    apply(mutation, f.ev, initial);
    expect(clears).toHaveLength(1);
    expect(clears[0]?.id).toBe(JID);
    expect(clears[0]?.messageRange).toBe(decodedRange);
    expect(decodedRange?.messages?.[0]?.key).toMatchObject(old.key);
    f.ev.flush();
    expect(deletes).toEqual(action === 'delete' && !initial ? [[JID]] : []);
    expect(history.read(JID).messages.map((row) => row.messageId)).toEqual(['newer']);
    expect(f.keys.lookup(JID, 'old')).toMatchObject(old.key);
    expect(f.incoming).toEqual([]);
    history.close();
    history = createHistory('fixture');
    const reopened = fixture();
    reopened.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [old, newer, selected] });
    expect(history.read(JID).messages.map((row) => row.messageId)).toEqual(['newer']);
    expect(reopened.incoming).toEqual([]);
  });

  test.each(cases)('$action, initial=$initial: a superseded connection cannot clear content', async ({ action, initial }) => {
    const f = fixture();
    const now = Math.floor(Date.now() / 1000) - 60;
    const old = message('kept', now);
    f.ev.emit('messages.upsert', { messages: [old], type: 'append' });
    const mutation = await authenticatedMutation(action, { lastMessageTimestamp: now, messages: [{ key: old.key, timestamp: now }] });
    f.retire();
    apply(mutation, f.ev, initial);
    expect(history.read(JID).messages.map((row) => row.messageId)).toEqual(['kept']);
    expect(f.incoming).toEqual([]);
  });

  test.each(cases)('$action, initial=$initial: unknown ranges make only that chat unavailable', async ({ action, initial }) => {
    const now = Math.floor(Date.now() / 1000);
    const ranges: (Range | undefined)[] = [undefined, {}, { lastMessageTimestamp: -1 }, { lastSystemMessageTimestamp: now }];
    for (const [index, range] of ranges.entries()) {
      history.close();
      const account = `unknown-${index}`;
      history = createHistory(account);
      const f = fixture();
      const unrelated = { ...message('unrelated', now - 20), key: { id: 'unrelated', remoteJid: 'other@g.us', participant: OTHER, fromMe: false } };
      f.ev.emit('messages.upsert', { messages: [message('old', now - 60), message('newer', now - 40), unrelated], type: 'append' });
      apply(await authenticatedMutation(action, range), f.ev, initial);
      expect(() => history.read(JID)).toThrow('chat deletion had no safe message range');
      expect(history.read('other@g.us').messages.map((row) => row.messageId)).toEqual(['unrelated']);
      expect(f.incoming).toEqual([]);
      history.close();
      history = createHistory(account);
      expect(() => history.read(JID)).toThrow('chat deletion had no safe message range');
      expect(history.read('other@g.us').messages.map((row) => row.messageId)).toEqual(['unrelated']);
    }
  });
});

describe('history deletion capability check', () => {
  test('detects the actual pinned SDK patch without a socket', () => {
    expect(supportsHistoryDeletion()).toBe(true);
  });

  test('refuses absent or partial deletion support', () => {
    expect(supportsHistoryDeletion(() => undefined)).toBe(false);
    expect(supportsHistoryDeletion((mutation, ev, me, initial, logger) => {
      if (!initial) processSyncAction(mutation, ev, me, initial, logger);
    })).toBe(false);
    expect(supportsHistoryDeletion((mutation, ev, me, initial, logger) => {
      if (mutation.index[0] === 'deleteChat') processSyncAction(mutation, ev, me, initial, logger);
    })).toBe(false);
  });

  test('returns unavailable rather than crashing if the SDK probe throws', () => {
    expect(supportsHistoryDeletion(() => { throw new Error('fixture unsupported action'); })).toBe(false);
  });
});
