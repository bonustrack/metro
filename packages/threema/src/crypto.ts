import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';

export const MSG_TEXT = 0x01;
export const MSG_DELIVERY_RECEIPT = 0x80;
export const MSG_TYPING = 0x90;

export const RECEIPT_ACK = 0x03;
export const RECEIPT_DECLINE = 0x04;

const MESSAGE_ID_BYTES = 8;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function hexToBytes(hex: string, label: string): Uint8Array {
  if (!HEX_RE.test(hex)) throw new Error(`${label} is not hex`);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export const bytesToHex = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('hex');

export const keyPairFrom = (privateKeyHex: string): KeyPair =>
  nacl.box.keyPair.fromSecretKey(hexToBytes(privateKeyHex, 'private key'));

function pad(plain: Uint8Array): Uint8Array {
  const n = randomInt(1, 256);
  const out = new Uint8Array(plain.length + n);
  out.set(plain);
  out.fill(n, plain.length);
  return out;
}

function unpad(data: Uint8Array): Uint8Array | null {
  const n = data[data.length - 1];
  if (n === undefined || n < 1 || n > data.length) return null;
  return data.subarray(0, data.length - n);
}

export function seal(
  plain: Uint8Array,
  theirPublicKey: Uint8Array,
  mine: KeyPair,
): { nonce: Uint8Array; box: Uint8Array } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return {
    nonce,
    box: nacl.box(pad(plain), nonce, theirPublicKey, mine.secretKey),
  };
}

export function open(
  box: Uint8Array,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mine: KeyPair,
): Uint8Array | null {
  const padded = nacl.box.open(box, nonce, theirPublicKey, mine.secretKey);
  return padded === null ? null : unpad(padded);
}

export function encodeText(text: string): Uint8Array {
  const utf8 = Buffer.from(text, 'utf8');
  const out = new Uint8Array(1 + utf8.length);
  out[0] = MSG_TEXT;
  out.set(utf8, 1);
  return out;
}

export type Decoded =
  | { kind: 'text'; text: string }
  | { kind: 'receipt'; status: number; messageIds: string[] }
  | { kind: 'typing' }
  | { kind: 'other'; type: number };

function receiptIds(body: Uint8Array): string[] {
  const ids: string[] = [];
  for (let at = 1; at + MESSAGE_ID_BYTES <= body.length; at += MESSAGE_ID_BYTES)
    ids.push(bytesToHex(body.subarray(at, at + MESSAGE_ID_BYTES)));
  return ids;
}

export function decode(plain: Uint8Array): Decoded {
  const type = plain[0];
  const body = plain.subarray(1);
  if (type === MSG_TEXT)
    return { kind: 'text', text: Buffer.from(body).toString('utf8') };
  if (type === MSG_DELIVERY_RECEIPT)
    return { kind: 'receipt', status: body[0] ?? 0, messageIds: receiptIds(body) };
  if (type === MSG_TYPING) return { kind: 'typing' };
  return { kind: 'other', type: type ?? -1 };
}

export interface CallbackFields {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nonce: string;
  box: string;
}

export const callbackMac = (secret: string, f: CallbackFields): string =>
  createHmac('sha256', secret)
    .update(f.from + f.to + f.messageId + f.date + f.nonce + f.box)
    .digest('hex');

export function macMatches(
  secret: string,
  fields: CallbackFields,
  mac: string,
): boolean {
  const want = Buffer.from(callbackMac(secret, fields), 'hex');
  const got = Buffer.from(mac.toLowerCase(), 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

const QUOTE_RE = /^> quote #([0-9a-f]{16})\n\n([\s\S]*)$/;

export const quoted = (replyTo: string, text: string): string =>
  `> quote #${replyTo}\n\n${text}`;

export function unquote(text: string): { replyTo?: string; text: string } {
  const m = QUOTE_RE.exec(text);
  const replyTo = m?.[1];
  const body = m?.[2];
  return replyTo === undefined || body === undefined ? { text } : { replyTo, text: body };
}
