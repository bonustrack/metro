import type { WAMessage, WAMessageKey, proto } from 'baileys';
import { mediaRefIn, mediaTag, type WAMediaRef } from './media.js';
import type { InboundMessage, ReactionInput } from './format.js';

export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');
const isLidJid = (jid: string): boolean => jid.endsWith('@lid');
export const isPrivateJid = (jid: string): boolean =>
  jid.endsWith('@s.whatsapp.net') || isLidJid(jid);

type Timestamp = number | { toNumber(): number } | null | undefined;

export function tsToDate(ts: Timestamp): Date {
  if (typeof ts === 'number') return new Date(ts * 1000);
  if (ts && typeof ts.toNumber === 'function')
    return new Date(ts.toNumber() * 1000);
  return new Date();
}

type Content = proto.IMessage | null | undefined;

const UNWRAPPERS: ((m: proto.IMessage) => Content)[] = [
  (m) => m.ephemeralMessage?.message,
  (m) => m.viewOnceMessage?.message,
  (m) => m.viewOnceMessageV2?.message,
  (m) => m.viewOnceMessageV2Extension?.message,
  (m) => m.deviceSentMessage?.message,
  (m) => m.documentWithCaptionMessage?.message,
  (m) => m.editedMessage?.message,
];

function unwrapOnce(m: proto.IMessage): Content {
  for (const pick of UNWRAPPERS) {
    const inner = pick(m);
    if (inner) return inner;
  }
  return undefined;
}

export function unwrap(message: Content): proto.IMessage | undefined {
  let current: Content = message;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const inner = unwrapOnce(current);
    if (!inner) return current;
    current = inner;
  }
  return current ?? undefined;
}

function captionOf(message: proto.IMessage): string {
  const caption =
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption;
  return typeof caption === 'string' ? caption : '';
}

export function extractText(message: Content): string {
  const inner = unwrap(message);
  if (!inner) return '';
  if (typeof inner.conversation === 'string') return inner.conversation;
  const ext = inner.extendedTextMessage?.text;
  if (typeof ext === 'string') return ext;
  return captionOf(inner);
}

export function mediaRefOf(message: Content): WAMediaRef | undefined {
  const inner = unwrap(message);
  return inner ? mediaRefIn(inner) : undefined;
}

function projectText(
  message: proto.IMessage | undefined,
  ref: WAMediaRef | undefined,
): string {
  return [extractText(message), mediaTag(ref)].filter(Boolean).join(' ');
}

function senderJidOf(key: WAMessageKey, chatJid: string): string {
  if (isGroupJid(chatJid)) return key.participant ?? chatJid;
  return chatJid;
}

export interface SelfRef {
  jids: ReadonlySet<string>;
  sentByMe: (chatJid: string, id: string) => boolean;
}

const QUOTING_NODES = [
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'audioMessage',
  'stickerMessage',
] as const;

function contextInfoOf(inner: proto.IMessage): proto.IContextInfo | undefined {
  for (const node of QUOTING_NODES) {
    const ctx = inner[node]?.contextInfo;
    if (ctx) return ctx;
  }
  return undefined;
}

function quoteFacts(ctx: proto.IContextInfo, replyTo: string | undefined, chatJid: string, self: SelfRef): Addressing {
  const quotedBy = typeof ctx.participant === 'string' ? ctx.participant : '';
  const mentioned = (ctx.mentionedJid ?? []).some((jid) => self.jids.has(jid));
  const replyToSelf = replyTo !== undefined && (self.jids.has(quotedBy) || self.sentByMe(chatJid, replyTo));
  return {
    ...(mentioned ? { mentionsSelf: true } : {}),
    ...(replyToSelf ? { replyToSelf: true } : {}),
  };
}

type Addressing = Pick<InboundMessage, 'replyTo' | 'mentionsSelf' | 'replyToSelf'>;

function addressing(inner: proto.IMessage, chatJid: string, self: SelfRef | undefined): Addressing {
  const ctx = contextInfoOf(inner);
  if (ctx === undefined) return {};
  const replyTo = typeof ctx.stanzaId === 'string' && ctx.stanzaId !== '' ? ctx.stanzaId : undefined;
  const base: Addressing = replyTo === undefined ? {} : { replyTo };
  return self === undefined ? base : { ...base, ...quoteFacts(ctx, replyTo, chatJid, self) };
}

export function toInbound(
  accountId: string,
  m: WAMessage,
  self?: SelfRef,
): InboundMessage | undefined {
  const chatJid = m.key.remoteJid;
  const messageId = m.key.id;
  if (!chatJid || !messageId) return undefined;
  const inner = unwrap(m.message);
  if (!inner || inner.reactionMessage) return undefined;
  const media = mediaRefOf(inner);
  const text = projectText(inner, media);
  if (!text && !media) return undefined;
  return {
    accountId,
    chatJid,
    senderJid: senderJidOf(m.key, chatJid),
    messageId,
    text,
    date: tsToDate(m.messageTimestamp),
    isPrivate: isPrivateJid(chatJid),
    ...(m.pushName ? { pushName: m.pushName } : {}),
    ...(media ? { media } : {}),
    ...addressing(inner, chatJid, self),
  };
}

export interface ReactionEvent {
  key: WAMessageKey;
  reaction: proto.IReaction;
}

function reactorJid(
  reactorKey: WAMessageKey | undefined,
  chatJid: string,
): string {
  return reactorKey?.participant ?? reactorKey?.remoteJid ?? chatJid;
}

export function toReaction(
  accountId: string,
  event: ReactionEvent,
): ReactionInput | undefined {
  const chatJid = event.key.remoteJid;
  const messageId = event.key.id;
  if (!chatJid || !messageId) return undefined;
  const reactorKey = event.reaction.key ?? undefined;
  if (reactorKey?.fromMe) return undefined;
  const senderJid = reactorJid(reactorKey, chatJid);
  const emoji = event.reaction.text ?? '';
  return {
    accountId,
    chatJid,
    senderJid,
    messageId,
    emoji,
    date: new Date(),
    isPrivate: isPrivateJid(chatJid),
    removed: emoji === '',
  };
}
