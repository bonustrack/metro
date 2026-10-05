import { EventEmitter } from 'node:events';
import { makeEventBuffer, proto, type BinaryNode, type WASocket, type WAMessage } from 'baileys';
import { createClient } from '../src/client.js';
import type { ClientRuntime, WAClient } from '../src/client-types.js';
import { baileysLogger } from '../src/logger.js';

export const CHAT = '120363000000000001@g.us';
export const SELF = '447700900123@s.whatsapp.net';
export type Content = Parameters<WASocket['sendMessage']>[1];
type SendOptions = Parameters<WASocket['sendMessage']>[2];

function body(content: Content): proto.IMessage {
  if ('delete' in content) return { protocolMessage: { key: content.delete, type: proto.Message.ProtocolMessage.Type.REVOKE } };
  if ('edit' in content && 'text' in content) return {
    protocolMessage: { key: content.edit, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, timestampMs: Date.now(), editedMessage: { conversation: content.text } },
  };
  if ('text' in content) return { conversation: content.text };
  if ('document' in content) return { documentMessage: { fileName: content.fileName, mimetype: content.mimetype, caption: content.caption } };
  if ('react' in content) return { reactionMessage: content.react };
  throw new Error('Unexpected fixture send');
}

export function fixtureRuntime() {
  const ev = makeEventBuffer(baileysLogger('fixture'));
  const ws = new EventEmitter();
  const sent: Content[] = [];
  const options: SendOptions[] = [];
  const generated: WAMessage[] = [];
  let error: string | undefined;
  let autoAck = true;
  let emitOwnEvents: boolean | undefined;
  let groupCalls = 0;
  let metadata = (): Promise<number | undefined> => Promise.resolve(undefined);
  let end = (): Promise<void> => Promise.resolve();
  const ack = (id: string, jid = CHAT) => ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { id, from: jid, ...(error ? { error } : {}) } });
  const sock = {
    ev, ws, user: { id: SELF, name: 'Fixture' },
    end: () => end(),
    sendMessage: (jid: string, content: Content, opts?: SendOptions) => {
      sent.push(content);
      options.push(opts);
      const id = `out-${sent.length}`;
      const message: WAMessage = { key: { id, remoteJid: jid, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: body(content) };
      generated.push(message);
      if (autoAck) ack(id, jid);
      return Promise.resolve(message);
    },
    groupMetadata: async (jid: string) => {
      groupCalls++;
      return { id: jid, subject: 'Fixture group', owner: SELF, creation: 1, size: 1, participants: [{ id: SELF, admin: 'admin' as const }], ephemeralDuration: await metadata() };
    },
    query: (node: BinaryNode): Promise<BinaryNode> => Promise.resolve({
      tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'group', attrs: { id: node.attrs.to ?? CHAT, size: '1' }, content: [{ tag: 'participant', attrs: { jid: SELF, type: 'admin' } }] }],
    }),
  } as WASocket;
  const runtime: ClientRuntime = {
    makeSocket: (config) => { emitOwnEvents = config.emitOwnEvents; return sock; },
    fetchVersion: () => Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
  };
  return {
    runtime, ev, sock, sent, options, generated, ack,
    get emitOwnEvents() { return emitOwnEvents; },
    get groupCalls() { return groupCalls; },
    setError(value?: string) { error = value; },
    setAutoAck(value: boolean) { autoAck = value; },
    setMetadata(value: typeof metadata) { metadata = value; },
    setEnd(value: typeof end) { end = value; },
  };
}

export async function fixture(clients: WAClient[], accountId = 'fixture') {
  const f = fixtureRuntime();
  const live: WAMessage[] = [];
  const client = createClient({ id: accountId, phone: '447700900123', credentials: { creds: {} } }, f.runtime);
  clients.push(client);
  await client.start({ onMessage: (_m, raw) => live.push(raw), onReaction() {} });
  f.ev.emit('connection.update', { connection: 'open' });
  return Object.assign(f, { client, live });
}
