import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';

export interface TransferEnvelope {
  key: string;
  iv: string;
  tag: string;
  data: string;
}

export const transferKeys = (): { publicKey: string; privateKey: KeyObject } => {
  const pair = generateKeyPairSync('x25519');
  return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey };
};

function sharedKey(privateKey: KeyObject, pem: string): ArrayBuffer {
  if (pem.length > 1024) throw new ApiError('invalid transfer key', 400);
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== 'x25519') throw new ApiError('invalid transfer key', 400);
  return hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), '', 'metro-connector-copy-v1', 32);
}

export function sealTransfer(value: unknown, publicKey: string): TransferEnvelope {
  const pair = transferKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(sharedKey(pair.privateKey, publicKey)), iv);
  const plain = JSON.stringify(value);
  if (Buffer.byteLength(plain) > 3 * 1024 * 1024) throw new ApiError('too many connector settings for one copy', 413);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { key: pair.publicKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openTransfer(raw: unknown, privateKey: KeyObject): unknown {
  if (!isRecord(raw) || typeof raw.key !== 'string' || typeof raw.iv !== 'string' || typeof raw.tag !== 'string' || typeof raw.data !== 'string')
    throw new ApiError('invalid encrypted transfer', 400);
  const iv = Buffer.from(raw.iv, 'base64');
  const tag = Buffer.from(raw.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new ApiError('invalid encrypted transfer', 400);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(sharedKey(privateKey, raw.key)), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as unknown;
}
