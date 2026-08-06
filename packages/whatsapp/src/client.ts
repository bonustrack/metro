import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import type { WhatsAppAccount } from './types.js';
import type { InboundMessage, ReactionInput } from './format.js';
import { toInbound, toReaction, type ReactionEvent } from './parse.js';
import { silentLogger } from './logger.js';
import { useAccountAuthState } from './auth-state.js';
import { knownKey, makeKeyCache, targetKey, type KeyCache } from './keys.js';

export interface InboundHandlers {
  onMessage(m: InboundMessage, raw: WAMessage): void;
  onReaction(r: ReactionInput): void;
}

export interface WAMedia {
  kind: string;
  path: string;
  mime: string;
  name: string;
  caption?: string;
}

export interface WAClient {
  account: WhatsAppAccount;
  start(handlers: InboundHandlers): Promise<void>;
  sendText(jid: string, text: string, quotedId?: string): Promise<string>;
  sendMedia(jid: string, media: WAMedia, quotedId?: string): Promise<string>;
  sendReaction(jid: string, messageId: string, emoji: string): Promise<void>;
  editMessage(jid: string, messageId: string, text: string): Promise<void>;
  deleteMessage(jid: string, messageId: string): Promise<void>;
  reuploadMedia(m: WAMessage): Promise<WAMessage>;
  disconnect(): Promise<void>;
}

interface State {
  account: WhatsAppAccount;
  handlers?: InboundHandlers;
  sock?: WASocket;
  closed: boolean;
  openResolve?: () => void;
  openPromise: Promise<void>;
  keys: KeyCache;
}

type SendOpts = Parameters<WASocket['sendMessage']>[2];
type SendContent = Parameters<WASocket['sendMessage']>[1];

function resetGate(st: State): void {
  st.openPromise = new Promise<void>((resolve) => {
    st.openResolve = resolve;
  });
}

function bindInbound(st: State, sock: WASocket): void {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) st.keys.remember(m.key);
    if (type !== 'notify' || !st.handlers) return;
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const inbound = toInbound(st.account.id, m);
      if (inbound) st.handlers.onMessage(inbound, m);
    }
  });
  sock.ev.on('messages.reaction', (events: ReactionEvent[]) => {
    if (!st.handlers) return;
    for (const event of events) {
      const reaction = toReaction(st.account.id, event);
      if (reaction) st.handlers.onReaction(reaction);
    }
  });
}

function onClose(st: State, code: number | undefined): void {
  if (st.closed || code === DisconnectReason.loggedOut) {
    const suffix = code === DisconnectReason.loggedOut ? ' — re-pair required' : '';
    process.stderr.write(
      `whatsapp[${st.account.id}] disconnected (code=${code ?? '?'})${suffix}\n`,
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
  const { version, error } = await fetchLatestWaWebVersion({});
  if (error) {
    throw new TrainError(
      'whatsapp_connect',
      `failed to fetch WhatsApp web version: ${errMsg(error)}`,
    );
  }
  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: silentLogger(),
  });
  st.sock = sock;
  sock.ev.on('creds.update', () => void saveCreds());
  bindConnection(st, sock);
  bindInbound(st, sock);
}

async function ready(st: State): Promise<WASocket> {
  await st.openPromise;
  if (!st.sock) throw new TrainError('whatsapp_call', 'socket not connected');
  return st.sock;
}

async function send(
  st: State,
  jid: string,
  content: SendContent,
  opts?: SendOpts,
): Promise<string> {
  const sock = await ready(st);
  const sent = await sock.sendMessage(jid, content, opts);
  st.keys.remember(sent?.key);
  return sent?.key.id ?? '';
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

export function createClient(account: WhatsAppAccount): WAClient {
  const st: State = {
    account,
    closed: false,
    openPromise: Promise.resolve(),
    keys: makeKeyCache(),
  };
  resetGate(st);
  return {
    account,
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
    },
    async reuploadMedia(m) {
      const sock = await ready(st);
      return sock.updateMediaMessage(m);
    },
    disconnect() {
      st.closed = true;
      try {
        st.sock?.end(undefined);
      } catch {
        st.sock = undefined;
      }
      return Promise.resolve();
    },
  };
}
