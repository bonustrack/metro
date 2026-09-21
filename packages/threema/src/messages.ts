import { bytesToHex, hexToBytes } from './crypto.js';

export const MSG_TEXT = 0x01;
export const MSG_FILE = 0x17;
export const MSG_GROUP_TEXT = 0x41;
export const MSG_GROUP_FILE = 0x46;
export const MSG_GROUP_SETUP = 0x4a;
export const MSG_GROUP_RENAME = 0x4b;
export const MSG_GROUP_LEAVE = 0x4c;
export const MSG_GROUP_REQUEST_SYNC = 0x51;
export const MSG_DELIVERY_RECEIPT = 0x80;
export const MSG_GROUP_DELIVERY_RECEIPT = 0x81;
export const MSG_REACTION = 0x82;
export const MSG_GROUP_REACTION = 0x83;
export const MSG_TYPING = 0x90;

export const RECEIPT_ACK = 0x03;
export const RECEIPT_DECLINE = 0x04;

export const ID_BYTES = 8;
const MESSAGE_ID_BYTES = 8;
const PROTO_MESSAGE_ID = 0x09;
const PROTO_APPLY = 0x12;
const PROTO_WITHDRAW = 0x1a;

export interface GroupRef {
  creator: string;
  groupId: string;
}

export interface FileData {
  blobId: string;
  key: string;
  mime: string;
  name: string;
  size: number | null;
  caption: string | null;
  media: boolean;
}

export type Decoded =
  | { kind: 'text'; text: string }
  | { kind: 'file'; group: GroupRef | null; file: FileData }
  | { kind: 'group-text'; group: GroupRef; text: string }
  | { kind: 'group-setup'; groupId: string; members: string[] }
  | { kind: 'group-rename'; groupId: string; name: string }
  | { kind: 'group-leave'; group: GroupRef }
  | { kind: 'receipt'; group: GroupRef | null; status: number; messageIds: string[] }
  | { kind: 'reaction'; group: GroupRef | null; messageId: string; emoji: string; removed: boolean }
  | { kind: 'typing' }
  | { kind: 'other'; type: number };

const ascii = (bytes: Uint8Array): string => Buffer.from(bytes).toString('ascii');
const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

const groupHeader = (group: GroupRef): Uint8Array =>
  new Uint8Array([...Buffer.from(group.creator, 'ascii'), ...hexToBytes(group.groupId, 'group id')]);

const readGroup = (body: Uint8Array): GroupRef | null =>
  body.length < ID_BYTES * 2 ? null : { creator: ascii(body.subarray(0, ID_BYTES)), groupId: bytesToHex(body.subarray(ID_BYTES, ID_BYTES * 2)) };

function ids(body: Uint8Array, from: number): string[] {
  const out: string[] = [];
  for (let at = from; at + MESSAGE_ID_BYTES <= body.length; at += MESSAGE_ID_BYTES) out.push(bytesToHex(body.subarray(at, at + MESSAGE_ID_BYTES)));
  return out;
}

const members = (body: Uint8Array, from: number): string[] => {
  const out: string[] = [];
  for (let at = from; at + ID_BYTES <= body.length; at += ID_BYTES) out.push(ascii(body.subarray(at, at + ID_BYTES)));
  return out;
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const typed = (type: number, ...parts: Uint8Array[]): Uint8Array => concat(new Uint8Array([type]), ...parts);

export const encodeText = (text: string): Uint8Array => typed(MSG_TEXT, Buffer.from(text, 'utf8'));

export const encodeGroupText = (group: GroupRef, text: string): Uint8Array => typed(MSG_GROUP_TEXT, groupHeader(group), Buffer.from(text, 'utf8'));

const fileJson = (f: FileData): Uint8Array =>
  Buffer.from(
    JSON.stringify({
      b: f.blobId,
      k: f.key,
      m: f.mime,
      n: f.name,
      ...(f.size === null ? {} : { s: f.size }),
      i: f.media ? 1 : 0,
      j: f.media ? 1 : 0,
      ...(f.caption === null ? {} : { d: f.caption }),
    }),
    'utf8',
  );

export const encodeFile = (f: FileData): Uint8Array => typed(MSG_FILE, fileJson(f));

export const encodeGroupFile = (group: GroupRef, f: FileData): Uint8Array => typed(MSG_GROUP_FILE, groupHeader(group), fileJson(f));

const HEX_RE = /^[0-9a-f]+$/i;

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v !== '' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const hexOf = (v: unknown, length: number): string | null => {
  const text = typeof v === 'string' ? v.toLowerCase() : '';
  return text.length === length && HEX_RE.test(text) ? text : null;
};

function parseJson(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(utf8(raw));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function decodeFileJson(raw: Uint8Array): FileData | null {
  const o = parseJson(raw);
  if (o === null) return null;
  const blobId = hexOf(o.b, 32);
  const key = hexOf(o.k, 64);
  if (blobId === null || key === null) return null;
  const rendering = num(o.j) ?? num(o.i) ?? 0;
  return {
    blobId,
    key,
    mime: str(o.m, 'application/octet-stream'),
    name: str(o.n, 'file'),
    size: num(o.s),
    caption: typeof o.d === 'string' && o.d !== '' ? o.d : null,
    media: rendering === 1,
  };
}

export const encodeGroupSyncRequest = (groupId: string): Uint8Array => typed(MSG_GROUP_REQUEST_SYNC, hexToBytes(groupId, 'group id'));

function varint(n: number): Uint8Array {
  const out: number[] = [];
  let rest = n;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return new Uint8Array(out);
}

export function encodeReactionProto(messageId: string, emoji: string, removed: boolean): Uint8Array {
  const emojiBytes = Buffer.from(emoji, 'utf8');
  return concat(
    new Uint8Array([PROTO_MESSAGE_ID]),
    hexToBytes(messageId, 'message id'),
    new Uint8Array([removed ? PROTO_WITHDRAW : PROTO_APPLY]),
    varint(emojiBytes.length),
    emojiBytes,
  );
}

export const encodeReaction = (messageId: string, emoji: string, removed: boolean): Uint8Array =>
  typed(MSG_REACTION, encodeReactionProto(messageId, emoji, removed));

export const encodeGroupReaction = (group: GroupRef, messageId: string, emoji: string, removed: boolean): Uint8Array =>
  typed(MSG_GROUP_REACTION, groupHeader(group), encodeReactionProto(messageId, emoji, removed));

function readVarint(body: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 1;
  for (let i = at; i < body.length; i++) {
    const byte = body[i] ?? 0;
    value += (byte & 0x7f) * shift;
    if (byte < 0x80) return { value, next: i + 1 };
    shift *= 0x80;
  }
  return null;
}

interface ProtoField {
  tag: number;
  bytes: Uint8Array;
  next: number;
}

function readField(body: Uint8Array, at: number): ProtoField | null {
  const tag = body[at] ?? 0;
  if (tag === PROTO_MESSAGE_ID)
    return at + 1 + MESSAGE_ID_BYTES > body.length ? null : { tag, bytes: body.subarray(at + 1, at + 1 + MESSAGE_ID_BYTES), next: at + 1 + MESSAGE_ID_BYTES };
  if (tag !== PROTO_APPLY && tag !== PROTO_WITHDRAW) return null;
  const len = readVarint(body, at + 1);
  if (len === null || len.next + len.value > body.length) return null;
  return { tag, bytes: body.subarray(len.next, len.next + len.value), next: len.next + len.value };
}

export function decodeReactionProto(body: Uint8Array): { messageId: string; emoji: string; removed: boolean } | null {
  let messageId: string | null = null;
  let emoji = '';
  let removed = false;
  for (let at = 0; at < body.length; ) {
    const field = readField(body, at);
    if (field === null) return null;
    if (field.tag === PROTO_MESSAGE_ID) messageId = bytesToHex(field.bytes);
    else {
      emoji = utf8(field.bytes);
      removed = field.tag === PROTO_WITHDRAW;
    }
    at = field.next;
  }
  return messageId === null || emoji === '' ? null : { messageId, emoji, removed };
}

function decodeGroup(type: number, body: Uint8Array): Decoded {
  const group = readGroup(body);
  if (group === null) return { kind: 'other', type };
  const rest = body.subarray(ID_BYTES * 2);
  if (type === MSG_GROUP_TEXT) return { kind: 'group-text', group, text: utf8(rest) };
  if (type === MSG_GROUP_FILE) {
    const file = decodeFileJson(rest);
    return file === null ? { kind: 'other', type } : { kind: 'file', group, file };
  }
  if (type === MSG_GROUP_LEAVE) return { kind: 'group-leave', group };
  if (type === MSG_GROUP_DELIVERY_RECEIPT) return { kind: 'receipt', group, status: rest[0] ?? 0, messageIds: ids(rest, 1) };
  const reaction = decodeReactionProto(rest);
  return reaction === null ? { kind: 'other', type } : { kind: 'reaction', group, ...reaction };
}

const GROUP_TYPES = new Set([MSG_GROUP_TEXT, MSG_GROUP_FILE, MSG_GROUP_LEAVE, MSG_GROUP_DELIVERY_RECEIPT, MSG_GROUP_REACTION]);
const DIRECT_TYPES = new Set([MSG_TEXT, MSG_FILE, MSG_TYPING, MSG_DELIVERY_RECEIPT, MSG_REACTION]);

function decodeControl(type: number, body: Uint8Array): Decoded {
  if (body.length < ID_BYTES) return { kind: 'other', type };
  const groupId = bytesToHex(body.subarray(0, ID_BYTES));
  if (type === MSG_GROUP_SETUP) return { kind: 'group-setup', groupId, members: members(body, ID_BYTES) };
  return { kind: 'group-rename', groupId, name: utf8(body.subarray(ID_BYTES)) };
}

function decodeDirect(type: number, body: Uint8Array): Decoded {
  if (type === MSG_TEXT) return { kind: 'text', text: utf8(body) };
  if (type === MSG_FILE) {
    const file = decodeFileJson(body);
    return file === null ? { kind: 'other', type } : { kind: 'file', group: null, file };
  }
  if (type === MSG_TYPING) return { kind: 'typing' };
  if (type === MSG_DELIVERY_RECEIPT) return { kind: 'receipt', group: null, status: body[0] ?? 0, messageIds: ids(body, 1) };
  const reaction = decodeReactionProto(body);
  return reaction === null ? { kind: 'other', type } : { kind: 'reaction', group: null, ...reaction };
}

export function decode(plain: Uint8Array): Decoded {
  const type = plain[0] ?? -1;
  const body = plain.subarray(1);
  if (DIRECT_TYPES.has(type)) return decodeDirect(type, body);
  if (type === MSG_GROUP_SETUP || type === MSG_GROUP_RENAME) return decodeControl(type, body);
  if (GROUP_TYPES.has(type)) return decodeGroup(type, body);
  return { kind: 'other', type };
}
