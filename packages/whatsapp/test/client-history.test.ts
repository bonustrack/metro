import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEventBuffer, proto, type WASocket, type WAMessage } from 'baileys';
import { createClient, type WAClient } from '../src/client.ts';
import type { ClientRuntime } from '../src/client-types.ts';
import { createHistory } from '../src/history.ts';
import { baileysLogger } from '../src/logger.ts';

const CHAT = '120363000000000001@g.us';
const SELF = '447700900123@s.whatsapp.net';
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

type Content = Parameters<WASocket['sendMessage']>[1];

function body(content: Content): proto.IMessage {
  if ('delete' in content) return { protocolMessage: { key: content.delete, type: proto.Message.ProtocolMessage.Type.REVOKE } };
  if ('edit' in content && 'text' in content) return {
    protocolMessage: { key: content.edit, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, editedMessage: { conversation: content.text } },
  };
  if ('text' in content) return { conversation: content.text };
  if ('document' in content) return { documentMessage: { fileName: content.fileName, mimetype: content.mimetype, caption: content.caption } };
  if ('react' in content) return { reactionMessage: content.react };
  throw new Error('Unexpected fixture send');
}

async function fixture(accountId = 'fixture'): Promise<{
  client: WAClient;
  ev: ReturnType<typeof makeEventBuffer>;
  sent: Content[];
  live: WAMessage[];
  emitOwnEvents: boolean | undefined;
  setError(error?: string): void;
}> {
  const ev = makeEventBuffer(baileysLogger('fixture'));
  const ws = new EventEmitter();
  const sent: Content[] = [];
  const live: WAMessage[] = [];
  let error: string | undefined;
  let emitOwnEvents: boolean | undefined;
  const sock = {
    ev, ws, user: { id: SELF, name: 'Fixture' },
    end: () => Promise.resolve(),
    sendMessage: (jid: string, content: Content) => {
      sent.push(content);
      const id = `out-${sent.length}`;
      const message: WAMessage = { key: { id, remoteJid: jid, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: body(content) };
      ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { id, from: jid, ...(error ? { error } : {}) } });
      return Promise.resolve(message);
    },
    groupMetadata: (jid: string) => Promise.resolve({ id: jid, subject: 'Fixture group', owner: SELF, creation: 1, size: 1, participants: [{ id: SELF, admin: 'admin' as const }] }),
  } as WASocket;
  const runtime: ClientRuntime = {
    makeSocket: (config) => { emitOwnEvents = config.emitOwnEvents; return sock; },
    fetchVersion: () => Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
  };
  const client = createClient({ id: accountId, phone: '447700900123', credentials: { creds: {} } }, runtime);
  clients.push(client);
  await client.start({ onMessage: (_m, raw) => live.push(raw), onReaction() {} });
  ev.emit('connection.update', { connection: 'open' });
  return { client, ev, sent, live, emitOwnEvents, setError(value) { error = value; } };
}

describe('WhatsApp client local history integration', () => {
  test('accepted own sends and media are retained without inbound replay', async () => {
    const f = await fixture();
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
    const f = await fixture();
    f.setError('463');
    await expect(f.client.sendText(CHAT, 'refused')).rejects.toMatchObject({ code: 'whatsapp_account_restricted' });
    expect((await f.client.read(CHAT)).messages).toEqual([]);
  });

  test('edits and deletes change history only after successful verdicts', async () => {
    const f = await fixture();
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

  test('reading persisted history restores the original group participant key', async () => {
    const history = createHistory('fixture');
    const key = { id: 'group-past', remoteJid: CHAT, participant: '123@lid', fromMe: false };
    history.ingest([{ key, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'past' } }]);
    history.close();
    const f = await fixture();
    await f.client.read(CHAT);
    await f.client.sendReaction(CHAT, key.id, 'x');
    expect(f.sent[0]).toEqual({ react: { text: 'x', key } });
    expect((await f.client.read(CHAT)).count).toBe(1);
  });

  test('group roster uses metadata and direct chat does not open a socket', async () => {
    const f = await fixture();
    expect(await f.client.listMembers(CHAT)).toMatchObject({ members: [{ id: SELF, is_admin: true }], capability: { supported: true, complete: true, total: 1 } });
    const offline = createClient({ id: 'offline', phone: '1', credentials: { creds: {} } });
    clients.push(offline);
    expect(await offline.listMembers(SELF)).toMatchObject({ capability: { supported: false } });
  });

  test('disconnect blocks later message events from recreating history', async () => {
    const f = await fixture();
    await f.client.sendText(CHAT, 'before close');
    await f.client.disconnect();
    f.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'late', remoteJid: CHAT }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'late' } }] });
    const stored = createHistory('fixture');
    expect(stored.read(CHAT).messages.map((m) => m.text)).toEqual(['before close']);
    stored.close();
    expect(f.live).toEqual([]);
  });
});
