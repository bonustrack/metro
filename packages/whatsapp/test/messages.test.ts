import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEventBuffer, type WAMessage } from 'baileys';
import { createHistory, type History } from '../src/history.ts';
import { makeKeyCache } from '../src/keys.ts';
import { makeNameBook } from '../src/names.ts';
import { baileysLogger } from '../src/logger.ts';
import { bindMessages } from '../src/messages.ts';

const JID = '123@g.us';
const SELF = '447700900111@s.whatsapp.net';
const OTHER = '222@lid';

function message(id: string, fromMe = false): WAMessage {
  return {
    key: { id, remoteJid: JID, participant: fromMe ? SELF : OTHER, fromMe },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: fromMe ? 'Self' : 'Other',
    message: { conversation: `fixture ${id}` },
  };
}

describe('WhatsApp message retention without historical replay', () => {
  let dir: string;
  let previous: string | undefined;
  let history: History;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metro-wa-events-'));
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
    names: ReturnType<typeof makeNameBook>;
    retire(): void;
  } {
    const ev = makeEventBuffer(baileysLogger('fixture'));
    const incoming: WAMessage[] = [];
    const keys = makeKeyCache();
    const names = makeNameBook();
    let current = true;
    bindMessages({ ev, user: { id: SELF } }, {
      accountId: 'fixture', keys, names, history,
      current: () => current,
      self: () => ({ jids: new Set([SELF]), sentByMe: () => false }),
      handlers: () => ({ onMessage: (_, raw) => incoming.push(raw), onReaction: () => undefined }),
    });
    return { ev, incoming, keys, names, retire: () => { current = false; } };
  }

  test('synced text, own sends and media never reach live inbound or media downloader', () => {
    const f = fixture();
    const own = message('own', true);
    const media = message('media');
    media.message = { imageMessage: { caption: 'fixture caption', mimetype: 'image/png', url: 'https://must-not-fetch.invalid/media', mediaKey: new Uint8Array([1, 2]) } };
    f.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [message('past'), own, media] });
    expect(f.incoming).toEqual([]);
    const page = history.read(JID);
    expect(page.messages).toHaveLength(3);
    expect(page.messages.find((m) => m.messageId === 'own')).toMatchObject({ fromMe: true, senderJid: SELF });
    expect(JSON.stringify(page)).not.toContain('must-not-fetch');
    expect(JSON.stringify(page)).not.toContain('mediaKey');
    expect(f.keys.lookup(JID, 'past')?.participant).toBe(OTHER);
    expect(f.names.get(OTHER)).toBe('Other');
  });

  test('append upserts are retained quietly and notify retains live behavior', () => {
    const f = fixture();
    f.ev.emit('messages.upsert', { messages: [message('offline')], type: 'append' });
    expect(f.incoming).toHaveLength(0);
    f.ev.emit('messages.upsert', { messages: [message('phone-own', true)], type: 'notify' });
    expect(f.incoming).toHaveLength(0);
    f.ev.emit('messages.upsert', { messages: [message('live')], type: 'notify' });
    expect(f.incoming).toHaveLength(1);
    expect(f.incoming[0]?.key.id).toBe('live');
    expect(history.read(JID).messages).toHaveLength(3);
  });

  test('message deletions, revokes and ranged clears remove only matching stored content', () => {
    const f = fixture();
    const first = message('first');
    const second = message('second');
    f.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [first, second, message('third')] });
    f.ev.emit('messages.delete', { keys: [first.key] });
    f.ev.emit('messages.update', [{ key: second.key, update: { message: null } }]);
    expect(history.read(JID).messages.map((m) => m.messageId)).toEqual(['third']);
    f.ev.emit('chats.delete', [JID]);
    expect(history.read(JID).messages.map((m) => m.messageId)).toEqual(['third']);
    f.ev.emit('chats.clear', { id: JID, messageRange: { lastMessageTimestamp: Math.floor(Date.now() / 1000) } });
    expect(history.read(JID).messages).toEqual([]);
    expect(f.incoming).toEqual([]);
  });

  test('authoritative contacts and SDK mappings link history without replacing original keys', () => {
    const f = fixture();
    const pairs = [
      { pn: '111@s.whatsapp.net', lid: '111@lid' },
      { pn: '222@s.whatsapp.net', lid: '222@lid' },
      { pn: '333@s.whatsapp.net', lid: '333@lid' },
      { pn: '444@s.whatsapp.net', lid: '444@lid' },
    ] as const;
    const messages = pairs.map(({ lid }, i) => ({ ...message(`alias-${i}`), key: { id: `alias-${i}`, remoteJid: lid, fromMe: false } }));
    f.ev.emit('messages.upsert', { messages, type: 'append' });
    f.ev.emit('contacts.upsert', [{ id: pairs[0].pn, lid: pairs[0].lid, name: 'First' }]);
    f.ev.emit('contacts.update', [{ id: pairs[1].lid, phoneNumber: pairs[1].pn }]);
    f.ev.emit('lid-mapping.update', pairs[2]);
    f.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], lidPnMappings: [pairs[3]] });
    for (const [i, { pn, lid }] of pairs.entries()) {
      expect(history.read(pn).messages).toHaveLength(1);
      expect(history.read(pn).messages[0]?.key).toEqual({ id: `alias-${i}`, remoteJid: lid, fromMe: false });
    }
    expect(f.incoming).toEqual([]);
  });

  test('stale contact and mapping events cannot introduce history aliases', () => {
    const f = fixture();
    const pn = '111@s.whatsapp.net';
    const lid = '111@lid';
    f.ev.emit('messages.upsert', { messages: [{ ...message('kept'), key: { id: 'kept', remoteJid: lid, fromMe: false } }], type: 'append' });
    f.retire();
    f.ev.emit('contacts.upsert', [{ id: pn, lid }]);
    f.ev.emit('contacts.update', [{ id: lid, phoneNumber: pn }]);
    f.ev.emit('lid-mapping.update', { pn, lid });
    f.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], lidPnMappings: [{ pn, lid }] });
    expect(history.read(pn).messages).toEqual([]);
    expect(history.read(lid).messages.map((m) => m.messageId)).toEqual(['kept']);
  });

  test('events from a superseded connection cannot mutate history or emit inbound', () => {
    const f = fixture();
    const first = message('kept');
    f.ev.emit('messages.upsert', { messages: [first], type: 'append' });
    f.retire();
    f.ev.emit('messages.upsert', { messages: [message('stale')], type: 'notify' });
    f.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [message('old-sync')] });
    f.ev.emit('messages.delete', { jid: JID, all: true });
    f.ev.emit('messages.update', [{ key: first.key, update: { message: null } }]);
    f.ev.emit('chats.delete', [JID]);
    f.ev.emit('chats.clear', { id: JID, messageRange: { lastMessageTimestamp: Math.floor(Date.now() / 1000) } });
    expect(history.read(JID).messages.map((m) => m.messageId)).toEqual(['kept']);
    expect(f.incoming).toEqual([]);
  });
});
