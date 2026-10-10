import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BLOB_RE = /^[A-Za-z0-9_-]+$/;

export class SealError extends ApiError {}

const unreadable = (): SealError => new SealError('a sealed value could not be opened with this key', 500);

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new SealError('a sealing key must be 32 bytes', 500);
}

export const connectorAad = (owner: string, connectorId: string): string => `metro-connector/v1\n${owner}\n${connectorId}`;

export const dataKeyAad = (owner: string): string => `metro-connector-key/v1\n${owner}`;

export function sealWith(key: Buffer, aad: string, plain: Buffer): string {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
}

export function openWith(key: Buffer, aad: string, sealed: string): Buffer {
  checkKey(key);
  const [version, blob, extra] = sealed.split('.');
  if (version !== VERSION || blob === undefined || extra !== undefined || !BLOB_RE.test(blob)) throw unreadable();
  const raw = Buffer.from(blob, 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) throw unreadable();
  const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw unreadable();
  }
}
