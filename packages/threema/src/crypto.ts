import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';

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

const FILE_NONCE = new Uint8Array([...new Array<number>(23).fill(0), 1]);

export const newBlobKey = (): Uint8Array => nacl.randomBytes(nacl.secretbox.keyLength);

export const sealBlob = (data: Uint8Array, key: Uint8Array): Uint8Array => nacl.secretbox(data, FILE_NONCE, key);

export const openBlob = (data: Uint8Array, key: Uint8Array): Uint8Array | null => nacl.secretbox.open(data, FILE_NONCE, key);
