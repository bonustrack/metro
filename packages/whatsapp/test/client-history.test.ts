import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from 'baileys';
import { createClient, type WAClient } from '../src/client.js';
import { createHistory } from '../src/history.js';
import { CHAT, SELF, fixture } from './client-fixture.js';

const clients: WAClient[] = [];
let dir: string;
let prior: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-client-history-'));
  prior = process.env.WHATSAPP_TOKEN_DIR;
  process.env.WHATSAPP_TOKEN_DIR = dir;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  if (prior === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe('WhatsApp client local history integration', () => {
  test('accepted own sends and media are retained without inbound replay', async () => {
    const f = await fixture(clients);
    expect(f.emitOwnEvents).toBe(false);
    const id = await f.client.sendText(CHAT, 'sent locally');
    await f.client.sendMedia(CHAT, { kind: 'document', path: '/fixture/never-read.pdf', mime: 'application/pdf', name: 'fixture.pdf', caption: 'caption' });
    const page = await f.client.read(CHAT);
    expect(page.count).toBe(2);
    expect(page.messages.find((m) => m.messageId === id)).toMatchObject({ text: 'sent locally', fromMe: true, senderJid: SELF });
    expect(page.messages.find((m) => m.text === 'caption')?.attachments?.[0]).toMatchObject({ name: 'fixture.pdf', mime: 'application/pdf' });
    expect(JSON.stringify(page)).not.toContain('/fixture/never-read.pdf');
    expect(f.live).toEqual([]);
    await f.client.disconnect();
    const offline = createClient({ id: 'fixture', phone: '447700900123', credentials: { creds: {} } });
    clients.push(offline);
    expect((await offline.read(CHAT)).count).toBe(2);
  });

  test('explicit send refusal never adds an outgoing row', async () => {
    const f = await fixture(clients);
    f.setError('463');
    await expect(f.client.sendText(CHAT, 'refused')).rejects.toMatchObject({ code: 'whatsapp_account_restricted' });
    expect((await f.client.read(CHAT)).messages).toEqual([]);
  });

  test('edits and deletes change history only after successful verdicts', async () => {
    const f = await fixture(clients);
    const id = await f.client.sendText(CHAT, 'original');
    f.setError('500');
    await expect(f.client.editMessage(CHAT, id, 'refused edit')).rejects.toThrow('refused');
    expect((await f.client.read(CHAT)).messages[0]?.text).toBe('original');
    await expect(f.client.deleteMessage(CHAT, id)).rejects.toThrow('refused');
    expect((await f.client.read(CHAT)).count).toBe(1);
    f.setError();
    await f.client.editMessage(CHAT, id, 'accepted edit');
    expect((await f.client.read(CHAT)).messages.map((m) => m.text)).toEqual(['accepted edit']);
    await f.client.deleteMessage(CHAT, id);
    expect((await f.client.read(CHAT)).messages).toEqual([]);
    expect(f.live).toEqual([]);
  });

  test('an acknowledged older local edit cannot overwrite a newer linked-device revision', async () => {
    const f = await fixture(clients);
    const id = await f.client.sendText(CHAT, 'original');
    f.setAutoAck(false);
    const edited = f.client.editMessage(CHAT, id, 'older local edit');
    await Bun.sleep(10);
    const local = f.generated.at(-1);
    expect(local?.message?.protocolMessage?.timestampMs).toBeNumber();
    const newer = Date.now();
    f.ev.emit('messages.upsert', { type: 'append', messages: [{
      key: { id: 'linked-edit', remoteJid: CHAT, fromMe: true }, messageTimestamp: Math.floor(newer / 1000),
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id, remoteJid: CHAT, fromMe: true }, timestampMs: newer, editedMessage: { conversation: 'newer linked edit' } } },
    }] });
    await Bun.sleep(10);
    f.ack(local?.key.id ?? 'missing');
    await edited;
    expect((await f.client.read(CHAT)).messages.map((m) => m.text)).toEqual(['newer linked edit']);
  });

  test('reading persisted history restores the original group participant key', async () => {
    const history = createHistory('fixture');
    const key = { id: 'group-past', remoteJid: CHAT, participant: '123@lid', fromMe: false };
    history.ingest([{ key, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'past' } }]);
    history.close();
    const f = await fixture(clients);
    await f.client.read(CHAT);
    await f.client.sendReaction(CHAT, key.id, 'x');
    expect(f.sent[0]).toEqual({ react: { text: 'x', key } });
    expect((await f.client.read(CHAT)).count).toBe(1);
    expect(f.groupCalls).toBe(0);
  });

  test('group roster uses the raw query and direct chat does not open a socket', async () => {
    const f = await fixture(clients);
    expect(await f.client.listMembers(CHAT)).toMatchObject({ members: [{ id: SELF, is_admin: true }], capability: { supported: true, complete: true, total: 1 } });
    const offline = createClient({ id: 'offline', phone: '1', credentials: { creds: {} } });
    clients.push(offline);
    expect(await offline.listMembers(SELF)).toMatchObject({ capability: { supported: false } });
  });

  test('disconnect blocks later message events and new sends while awaiting socket end', async () => {
    const f = await fixture(clients);
    await f.client.sendText(CHAT, 'before close');
    const end = Promise.withResolvers<void>();
    f.setEnd(() => end.promise);
    let closed = false;
    const closing = f.client.disconnect().then(() => { closed = true; });
    await Bun.sleep(1);
    expect(closed).toBe(false);
    await expect(f.client.sendText(CHAT, 'late send')).rejects.toThrow('socket not connected');
    f.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'late', remoteJid: CHAT }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'late' } }] });
    const stored = createHistory('fixture');
    expect(stored.read(CHAT).messages.map((m) => m.text)).toEqual(['before close']);
    stored.close();
    end.resolve();
    await closing;
    expect(f.live).toEqual([]);
  });
});
