import { isRecord } from '@metro-labs/core/is-record';
import type { WAMessage, WAMessageKey, proto } from 'baileys';
import { mediaRefIn, type WAMediaRef } from './media.js';
import { extractText, isGroupJid, isPrivateJid } from './parse.js';
import { HISTORY_LIMITS, type StoredRow } from './history-types.js';

const KEY_STRINGS = [
  'remoteJid', 'id', 'participant', 'remoteJidAlt', 'remoteJidUsername',
  'participantAlt', 'participantUsername', 'server_id', 'addressingMode',
] as const;
const CONTEXT_NODES = [
  'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage',
  'documentMessage', 'stickerMessage',
] as const;

type Timestamp = number | { toNumber(): number } | null | undefined;

export function numberOf(value: Timestamp): number | undefined {
  const n = typeof value === 'number' ? value : value?.toNumber();
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function clipped(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const buffer = Buffer.from(text);
  let end = bytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

function keyStrings(value: Record<string, unknown>): [string, string | boolean | null][] | undefined {
  const fields: [string, string | boolean | null][] = [];
  for (const field of KEY_STRINGS) {
    const v = value[field];
    if (v === undefined) continue;
    if (v !== null && (typeof v !== 'string' || v.length > 256)) return undefined;
    fields.push([field, v]);
  }
  return fields;
}

export const historyJid = (jid: string): boolean => jid.length <= 256 && (isPrivateJid(jid) || isGroupJid(jid));

function identified(key: WAMessageKey): boolean {
  return Boolean(key.id) && historyJid(key.remoteJid ?? '');
}

export function historyKey(value: unknown): WAMessageKey | undefined {
  if (!isRecord(value)) return undefined;
  const fields = keyStrings(value);
  if (!fields) return undefined;
  for (const field of ['fromMe', 'isViewOnce']) {
    const v = value[field];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'boolean') return undefined;
    fields.push([field, v]);
  }
  const key: WAMessageKey = Object.fromEntries(fields);
  return identified(key) ? key : undefined;
}

interface Content {
  message?: proto.IMessage;
  ephemeral: boolean;
  forbidden: boolean;
}

function privateContent(message: proto.IMessage): boolean {
  return [message.viewOnceMessage, message.viewOnceMessageV2, message.viewOnceMessageV2Extension,
    message.imageMessage?.viewOnce, message.videoMessage?.viewOnce, message.audioMessage?.viewOnce,
    message.messageContextInfo?.messageAddOnExpiryType].some(Boolean);
}

function innerOf(message: proto.IMessage): proto.IMessage | undefined {
  const wrappers = [message.ephemeralMessage, message.deviceSentMessage, message.documentWithCaptionMessage, message.editedMessage];
  return wrappers.find((wrapper) => wrapper?.message)?.message ?? undefined;
}

export function historyContent(message: proto.IMessage | null | undefined): Content {
  if (!message) return { ephemeral: false, forbidden: false };
  let current = message;
  let ephemeral = false;
  for (let depth = 0; current && depth < 12; depth++) {
    if (privateContent(current)) return { ephemeral, forbidden: true };
    ephemeral ||= Boolean(current.ephemeralMessage);
    const inner = innerOf(current);
    if (!inner) return { message: current, ephemeral, forbidden: false };
    current = inner;
  }
  return { ephemeral, forbidden: true };
}

function contextOf(message: proto.IMessage): proto.IContextInfo | undefined {
  for (const field of CONTEXT_NODES) {
    const context = message[field]?.contextInfo;
    if (context) return context;
  }
  return undefined;
}

const durationGiven = (n: number | null | undefined): n is number => n !== undefined && n !== null && n !== 0;

function expiry(message: WAMessage, content: Content, at: number): number | false | undefined {
  const ctx = content.message ? contextOf(content.message) : undefined;
  const duration = [message.ephemeralDuration, ctx?.expiration].filter(durationGiven);
  if (duration.some((n) => !Number.isFinite(n) || n < 0)) return false;
  const ephemeral = [content.ephemeral, message.ephemeralStartTimestamp, ctx?.disappearingMode, ctx?.ephemeralSettingTimestamp].some(Boolean);
  if (!duration.length) return ephemeral ? false : undefined;
  const start = numberOf(message.ephemeralStartTimestamp);
  const base = start === undefined ? at : Math.min(at, start * 1000);
  const end = base + Math.min(...duration) * 1000;
  return Number.isSafeInteger(end) ? end : false;
}

function attachment(message: proto.IMessage): WAMediaRef | undefined {
  const media = mediaRefIn(message);
  if (!media) return undefined;
  return {
    kind: media.kind,
    ...(media.mime ? { mime: clipped(media.mime, 128) } : {}),
    ...(media.name ? { name: clipped(media.name, 256) } : {}),
    ...(Number.isSafeInteger(media.bytes) && (media.bytes ?? -1) >= 0 ? { bytes: media.bytes } : {}),
  };
}

function senderOf(key: WAMessageKey, selfJid?: string): string | undefined {
  const sender = key.fromMe ? selfJid : isGroupJid(key.remoteJid ?? '') ? key.participant : key.remoteJid;
  return typeof sender === 'string' && sender.length <= 256 ? sender : undefined;
}

function retainedExpiry(value: number | false | undefined, now: number): value is number | undefined {
  return value !== false && (value === undefined || value > now);
}

export function projectMessage(message: WAMessage, now: number, selfJid?: string): StoredRow | 'omit' | undefined {
  const key = historyKey(message.key);
  if (!key) return undefined;
  const content = historyContent(message.message);
  if (key.isViewOnce || content.forbidden) return 'omit';
  const at = (numberOf(message.messageTimestamp) ?? 0) * 1000;
  if (!at || at > now) return undefined;
  const expiresAt = expiry(message, content, at);
  if (!retainedExpiry(expiresAt, now)) return 'omit';
  if (!content.message) return undefined;
  return projectBody(key, content.message, at, selfJid, expiresAt);
}

function projectBody(key: WAMessageKey, message: proto.IMessage, at: number, selfJid?: string, expiresAt?: number): StoredRow | undefined {
  const source = extractText(message);
  const media = attachment(message);
  if (!source && !media) return undefined;
  const text = clipped(source, HISTORY_LIMITS.textBytes);
  const senderJid = senderOf(key, selfJid);
  return {
    key, at, text,
    ...(senderJid ? { senderJid } : {}),
    ...(text !== source ? { truncated: true } : {}),
    ...(media ? { attachments: [media] } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}
