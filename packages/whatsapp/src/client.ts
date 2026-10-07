import makeWASocket, {
  jidNormalizedUser,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type proto,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from 'baileys';
import { TrainError } from '@metro-labs/core/train-error';
import { errMsg } from '@metro-labs/core/log';
import type { WhatsAppAccount } from './types.js';
import type { InboundHandlers, WAClient, WAMedia, ClientRuntime } from './client-types.js';
export type { InboundHandlers, WAClient, WAMedia } from './client-types.js';
import { makeProfileCache, nonEmpty, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import type { SelfRef } from './parse.js';
import type { History } from './history.js';
import { createClientHistory } from './client-history.js';
import { WhatsAppChannels } from './channels.js';
import { bindMessages } from './messages.js';
import { listMembers } from './members.js';
import { SendExpiry } from './send-expiry.js';
import { baileysLogger } from './logger.js';
import { makeNameBook, nameFiles, phoneOf, type NameBook } from './names.js';
import { useAccountAuthState } from './auth-state.js';
import { knownKey, makeKeyCache, targetKey, type KeyCache } from './keys.js';
import { makeOutbox, type Outbox } from './outbox.js';
import { deliveryNotes, describeNote } from './delivery.js';
import {
  ACK_WAIT_MS,
  bindAcks,
  makeAckWatch,
  rejection,
  type AckWatch,
} from './ack.js';

interface State {
  account: WhatsAppAccount;
  runtime: ClientRuntime;
  history: History;
  expiry: SendExpiry;
  handlers?: InboundHandlers;
  sock?: WASocket;
  closed: boolean;
  closing?: Promise<void>;
  openResolve?: () => void;
  openPromise: Promise<void>;
  keys: KeyCache;
  outbox: Outbox;
  acks: AckWatch;
  names: NameBook;
  channels: WhatsAppChannels;
}
type SendOpts = Parameters<WASocket['sendMessage']>[2];
type SendContent = Parameters<WASocket['sendMessage']>[1];
function resetGate(st: State): void {
  st.openPromise = new Promise<void>((resolve) => {
    st.openResolve = resolve;
  });
}
function selfRef(st: State, sock: WASocket): SelfRef {
  const jids = new Set<string>();
  const me = sock.user;
  if (me?.id) jids.add(jidNormalizedUser(me.id));
  if (me?.lid) jids.add(jidNormalizedUser(me.lid));
  return { jids, sentByMe: (jid, id) => st.keys.lookup(jid, id)?.fromMe === true };
}

function bindInbound(st: State, sock: WASocket): void {
  bindMessages(sock, {
    accountId: st.account.id,
    keys: st.keys,
    names: st.names,
    history: st.history,
    current: () => !st.closed && st.sock === sock,
    handlers: () => st.handlers,
    self: () => selfRef(st, sock),
  });
}

function bindDelivery(st: State, sock: WASocket): void {
  sock.ev.on('messages.update', (updates) => {
    for (const note of deliveryNotes(updates))
      process.stderr.write(
        `whatsapp[${st.account.id}] send ${note.messageId} to ${note.jid}: ${describeNote(note)}\n`,
      );
  });
  bindAcks(sock, st.acks, (ack) => {
    process.stderr.write(
      `whatsapp[${st.account.id}] send ${ack.messageId} to ${ack.jid} REFUSED by WhatsApp: ack error ${ack.error ?? '?'}\n`,
    );
  });
}

function servedFromOutbox(
  st: State,
  key: WAMessageKey,
): proto.IMessage | undefined {
  const message = st.outbox.lookup(key);
  if (key.fromMe === true)
    process.stderr.write(
      message
        ? `whatsapp[${st.account.id}] asked to send ${key.id} to ${key.remoteJid} again — served from the outbox\n`
        : `whatsapp[${st.account.id}] asked to send ${key.id} to ${key.remoteJid} again — NOT in the outbox, so that message can never arrive\n`,
    );
  return message;
}

const TERMINAL: Record<number, string> = {
  [DisconnectReason.loggedOut]: ' — re-pair required',
  [DisconnectReason.connectionReplaced]:
    ' — another metro took this device; not reconnecting (two sockets on one ' +
    'identity evict each other and risk a 463 timelock)',
};

export function terminalReason(code: number | undefined): string | undefined {
  return code === undefined ? undefined : TERMINAL[code];
}

function onClose(st: State, code: number | undefined): void {
  const terminal = terminalReason(code);
  if (st.closed || terminal !== undefined) {
    process.stderr.write(
      `whatsapp[${st.account.id}] disconnected (code=${code ?? '?'})${terminal ?? ''}\n`,
    );
    return;
  }
  resetGate(st);
  process.stderr.write(`whatsapp[${st.account.id}] reconnecting\n`);
  void connect(st).catch((e: unknown) => {
    process.stderr.write(
      `whatsapp[${st.account.id}] reconnect failed: ${errMsg(e)}\n`,
    );
  });
}

function bindConnection(st: State, sock: WASocket): void {
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      process.stderr.write(`whatsapp[${st.account.id}] connected\n`);
      st.openResolve?.();
      return;
    }
    if (connection !== 'close') return;
    const code = (
      lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
    )?.output?.statusCode;
    onClose(st, code);
  });
}

async function connect(st: State): Promise<void> {
  const { state, saveCreds } = useAccountAuthState(
    st.account.credentials,
    st.account.id,
  );
  if (st.closed) return;
  const { version, error } = await st.runtime.fetchVersion({});
  if (st.closed) return;
  if (error) {
    throw new TrainError(
      'whatsapp_connect',
      `failed to fetch WhatsApp web version: ${errMsg(error)}`,
    );
  }
  const sock = st.runtime.makeSocket({
    version,
    auth: state,
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: false,
    logger: baileysLogger(st.account.id),
    getMessage: (key) => Promise.resolve(servedFromOutbox(st, key)),
  });
  st.sock = sock;
  sock.ev.on('creds.update', () => void saveCreds());
  bindConnection(st, sock);
  bindInbound(st, sock);
  st.channels.bind(sock, () => !st.closed && st.sock === sock);
  st.expiry.bind(sock, () => !st.closed && st.sock === sock);
  bindDelivery(st, sock);
}
async function lidFor(st: State, sock: WASocket, jid: string): Promise<string | null> {
  try {
    return await sock.signalRepository.lidMapping.getLIDForPN(jid);
  } catch (e) {
    process.stderr.write(
      `whatsapp[${st.account.id}] no lid on file for ${jid}: ${errMsg(e)}\n`,
    );
    return null;
  }
}
async function ready(st: State): Promise<WASocket> {
  await st.openPromise;
  if (st.closed || !st.sock) throw new TrainError('whatsapp_call', 'socket not connected');
  return st.sock;
}
async function send(
  st: State,
  jid: string,
  content: SendContent,
  opts?: SendOpts,
): Promise<string> {
  const sock = await ready(st);
  const expiration = await st.expiry.forSend(sock, jid, content);
  if (st.closed || st.sock !== sock) throw new TrainError('whatsapp_call', 'socket not connected');
  const sent = await sock.sendMessage(jid, content, expiration === undefined ? opts : { ...opts, ephemeralExpiration: expiration });
  const key = sent?.key;
  st.keys.remember(key);
  st.outbox.remember(key, sent?.message);
  const messageId = key?.id;
  if (!messageId)
    throw new TrainError(
      'whatsapp_call',
      `WhatsApp accepted no message for ${jid}, so there is nothing that can have arrived`,
    );
  const ack = await st.acks.wait(messageId, ACK_WAIT_MS);
  const refused = ack ? rejection(ack) : undefined;
  if (refused) throw refused;
  recordSent(st, sock, sent, expiration);
  return messageId;
}

function recordSent(st: State, sock: WASocket, sent: WAMessage | undefined, expiration?: number): void {
  if (!sent || st.closed) return;
  st.history.ingestSent([sent], sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined, expiration);
}

function quotedOpts(st: State, jid: string, quotedId: string): SendOpts {
  return {
    quoted: {
      key: knownKey(st.keys, jid, quotedId, false),
      message: { conversation: '' },
    },
  };
}

function mediaContent(m: WAMedia): SendContent {
  const source = { url: m.path };
  const caption = m.caption ? { caption: m.caption } : {};
  if (m.kind === 'image') return { image: source, ...caption };
  if (m.kind === 'video')
    return { video: source, mimetype: m.mime, ...caption };
  if (m.kind === 'audio')
    return { audio: source, mimetype: m.mime, ptt: false };
  return {
    document: source,
    mimetype: m.mime,
    fileName: m.name,
    ...caption,
  };
}

async function readProfile(st: State, jid: string): Promise<SenderProfile> {
  const sock = await ready(st);
  const [statuses, avatar] = await Promise.all([sock.fetchStatus(jid).catch(() => undefined), sock.profilePictureUrl(jid, 'image').catch(() => undefined)]);
  const about = nonEmpty((statuses?.[0]?.status as { status?: unknown } | undefined)?.status);
  const picture = nonEmpty(avatar);
  const phone = phoneOf(jid.endsWith('@lid') ? await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null) : jid);
  const name = st.names.get(jid);
  return {
    id: jid,
    ...(name === undefined ? {} : { display_name: name }),
    ...(phone === undefined ? {} : { name: phone, address: phone }),
    ...(about === undefined ? {} : { about }),
    ...(picture === undefined ? {} : { avatar: picture }),
  };
}

async function disconnect(st: State): Promise<void> {
  st.closed = true;
  st.openResolve?.();
  try {
    st.history.close();
  } finally {
    const sock = st.sock;
    st.sock = undefined;
    await sock?.end(undefined);
  }
}

function initialState(account: WhatsAppAccount, runtime: ClientRuntime): State {
  const st: State = {
    account,
    runtime,
    history: createClientHistory(account.id),
    expiry: new SendExpiry(account.id),
    closed: false,
    openPromise: Promise.resolve(),
    keys: makeKeyCache(),
    outbox: makeOutbox(),
    acks: makeAckWatch(),
    names: makeNameBook(nameFiles.path(account.id)),
    channels: new WhatsAppChannels(account.id),
  };
  resetGate(st);
  return st;
}

export function createClient(
  account: WhatsAppAccount,
  runtime: ClientRuntime = { makeSocket: makeWASocket, fetchVersion: fetchLatestWaWebVersion },
): WAClient {
  const st = initialState(account, runtime);
  const senders = makeProfileCache<SenderProfile>((jid) => readProfile(st, jid), {
    onError: (jid, err) => process.stderr.write(`whatsapp[${st.account.id}] could not read the profile of ${jid}: ${errMsg(err)}\n`),
  });
  return {
    account,
    self() {
      const jid = st.sock?.user?.id;
      if (jid === undefined) return null;
      return jid.split(':')[0]?.split('@')[0] ?? null;
    },
    async start(handlers) {
      st.handlers = handlers;
      try {
        await connect(st);
      } catch (e) {
        process.stderr.write(
          `whatsapp[${account.id}] connect failed: ${errMsg(e)}\n`,
        );
      }
    },
    read(jid, options) {
      const page = st.history.read(jid, options);
      for (const message of page.messages) st.keys.remember(message.key);
      return Promise.resolve(page);
    },
    listMembers(jid, limit) {
      return listMembers(jid, async (node): Promise<unknown> => await (await ready(st)).query(node), st.names, limit);
    },
    listChannels(args) {
      if (st.closed) return Promise.reject(new TrainError('whatsapp_call', 'socket not connected'));
      return st.channels.list(() => ready(st), args);
    },
    sendText(jid, text, quotedId) {
      return send(
        st,
        jid,
        { text },
        quotedId ? quotedOpts(st, jid, quotedId) : undefined,
      );
    },
    sendMedia(jid, media, quotedId) {
      return send(
        st,
        jid,
        mediaContent(media),
        quotedId ? quotedOpts(st, jid, quotedId) : undefined,
      );
    },
    async showTyping(jid) {
      const sock = await ready(st);
      await sock.sendPresenceUpdate('composing', jid);
    },
    async sendReaction(jid, messageId, emoji) {
      const target = targetKey(st.keys, jid, messageId, 'react to');
      await send(st, jid, { react: { text: emoji, key: target } });
    },
    async editMessage(jid, messageId, text) {
      await send(st, jid, {
        text,
        edit: knownKey(st.keys, jid, messageId, true),
      });
    },
    async deleteMessage(jid, messageId) {
      await send(st, jid, {
        delete: knownKey(st.keys, jid, messageId, true),
      });
      if (!st.closed) st.history.deleteMessages({ keys: [{ remoteJid: jid, id: messageId }] });
    },
    async reuploadMedia(m) {
      const sock = await ready(st);
      return sock.updateMediaMessage(m);
    },
    async lookupSender(number) {
      const sock = await ready(st);
      const found = (await sock.onWhatsApp(number))?.[0];
      if (found?.exists !== true) return { exists: false, jid: null, lid: null };
      const jid = jidNormalizedUser(found.jid);
      return { exists: true, jid, lid: await lidFor(st, sock, jid) };
    },
    async setProfile(change) {
      const sock = await ready(st);
      if (change.name !== undefined) await sock.updateProfileName(change.name);
      if (change.bio !== undefined) await sock.updateProfileStatus(change.bio);
      if (change.avatar !== undefined) {
        const me = sock.user?.id;
        if (me === undefined) throw new TrainError('whatsapp_call', 'own jid unknown');
        await sock.updateProfilePicture(me, { url: change.avatar.path });
      }
    },
    senderProfile: (jid) => senders.get(jid),
    disconnect: () => st.closing ??= disconnect(st),
  };
}
