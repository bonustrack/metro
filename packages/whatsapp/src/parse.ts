import type { WAMessage, WAMessageKey, proto } from '@whiskeysockets/baileys';
import type { InboundMessage, ReactionInput } from './format.js';

export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');
export const isPrivateJid = (jid: string): boolean =>
  jid.endsWith('@s.whatsapp.net');

type Timestamp = number | { toNumber(): number } | null | undefined;

export function tsToDate(ts: Timestamp): Date {
  if (typeof ts === 'number') return new Date(ts * 1000);
  if (ts && typeof ts.toNumber === 'function')
    return new Date(ts.toNumber() * 1000);
  return new Date();
}

type Content = proto.IMessage | null | undefined;

function captionOf(message: proto.IMessage): string {
  const caption =
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption;
  return typeof caption === 'string' ? caption : '';
}

export function extractText(message: Content): string {
  if (!message) return '';
  if (typeof message.conversation === 'string') return message.conversation;
  const ext = message.extendedTextMessage?.text;
  if (typeof ext === 'string') return ext;
  return captionOf(message);
}

const MEDIA_TAGS: [keyof proto.IMessage, string][] = [
  ['imageMessage', '[image]'],
  ['videoMessage', '[video]'],
  ['audioMessage', '[audio]'],
  ['documentMessage', '[document]'],
  ['stickerMessage', '[sticker]'],
];

function mediaTag(message: Content): string | undefined {
  if (!message) return undefined;
  for (const [key, tag] of MEDIA_TAGS) if (message[key]) return tag;
  return undefined;
}

export function hasMedia(message: Content): boolean {
  return mediaTag(message) !== undefined;
}

function projectText(message: Content): string {
  return [extractText(message), mediaTag(message)].filter(Boolean).join(' ');
}

function senderJidOf(key: WAMessageKey, chatJid: string): string {
  if (isGroupJid(chatJid)) return key.participant ?? chatJid;
  return chatJid;
}

export function toInbound(
  accountId: string,
  m: WAMessage,
): InboundMessage | undefined {
  const chatJid = m.key.remoteJid;
  const messageId = m.key.id;
  if (!chatJid || !messageId) return undefined;
  return {
    accountId,
    chatJid,
    senderJid: senderJidOf(m.key, chatJid),
    messageId,
    text: projectText(m.message),
    date: tsToDate(m.messageTimestamp),
    isPrivate: isPrivateJid(chatJid),
    ...(m.pushName ? { pushName: m.pushName } : {}),
    hasMedia: hasMedia(m.message),
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
