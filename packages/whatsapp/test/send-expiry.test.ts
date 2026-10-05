import { describe, expect, test } from 'bun:test';
import { proto, generateWAMessage } from 'baileys';
import { SendExpiry } from '../src/send-expiry.js';
import { baileysLogger } from '../src/logger.js';
import { CHAT, SELF, fixtureRuntime } from './client-fixture.js';

describe('send expiry metadata provenance', () => {
  test('pinned SDK returns expiry only when generation receives the explicit duration', async () => {
    const ordinary = await generateWAMessage(CHAT, { text: 'fixture' }, { userJid: SELF, logger: baileysLogger('fixture') });
    const timed = await generateWAMessage(CHAT, { text: 'fixture' }, { userJid: SELF, logger: baileysLogger('fixture'), ephemeralExpiration: 60 });
    expect(ordinary.message?.extendedTextMessage?.contextInfo?.expiration).toBeUndefined();
    expect(timed.message?.extendedTextMessage?.contextInfo?.expiration).toBe(60);
  });

  test('pinned protobuf default duration is not explicit direct metadata', async () => {
    const f = fixtureRuntime();
    const expiry = new SendExpiry('fixture');
    expiry.bind(f.sock, () => true);
    const chat = proto.Conversation.decode(proto.Conversation.encode({ id: SELF, ephemeralSettingTimestamp: 1 }).finish());
    expect(chat.ephemeralExpiration).toBeNull();
    expect(Object.hasOwn(chat, 'ephemeralExpiration')).toBe(false);
    f.ev.emit('messaging-history.set', { chats: [chat], contacts: [], messages: [], isLatest: false });
    expect(await expiry.forSend(f.sock, SELF, { text: 'fixture' })).toBeUndefined();
  });

  test('explicit synced duration is used only for its exact JID and is reset on reconnect', async () => {
    const f = fixtureRuntime();
    const expiry = new SendExpiry('fixture');
    let current = true;
    expiry.bind(f.sock, () => current);
    f.ev.emit('messaging-history.set', { chats: [{ id: SELF, ephemeralExpiration: 60, ephemeralSettingTimestamp: 1 }], contacts: [], messages: [], isLatest: true });
    expect(await expiry.forSend(f.sock, SELF, { text: 'fixture' })).toBe(60);
    expect(await expiry.forSend(f.sock, '123@lid', { text: 'fixture' })).toBeUndefined();
    current = false;
    f.ev.emit('chats.update', [{ id: SELF, ephemeralExpiration: null, ephemeralSettingTimestamp: 2 }]);
    expect(await expiry.forSend(f.sock, SELF, { text: 'fixture' })).toBe(60);
    const replacement = fixtureRuntime();
    expiry.bind(replacement.sock, () => true);
    expect(await expiry.forSend(replacement.sock, SELF, { text: 'fixture' })).toBeUndefined();
    f.ev.emit('chats.update', [{ id: SELF, ephemeralExpiration: 60, ephemeralSettingTimestamp: 3 }]);
    expect(await expiry.forSend(replacement.sock, SELF, { text: 'fixture' })).toBeUndefined();
  });

  test('chat deletion and bounded eviction forget old direct timer metadata', async () => {
    const f = fixtureRuntime();
    const expiry = new SendExpiry('fixture');
    expiry.bind(f.sock, () => true);
    f.ev.emit('chats.upsert', [{ id: SELF, ephemeralExpiration: 60, ephemeralSettingTimestamp: 1 }]);
    f.ev.emit('chats.delete', [SELF]);
    expect(await expiry.forSend(f.sock, SELF, { text: 'fixture' })).toBeUndefined();
    for (let i = 1; i <= 2001; i++) f.ev.emit('chats.update', [{ id: `${i}@lid`, ephemeralExpiration: 60, ephemeralSettingTimestamp: i }]);
    expect(await expiry.forSend(f.sock, '1@lid', { text: 'fixture' })).toBeUndefined();
    expect(await expiry.forSend(f.sock, '2001@lid', { text: 'fixture' })).toBe(60);
  });
});
