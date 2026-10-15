import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_MAX = 64 * 1024;
const BLOB_RE = /^[A-Za-z0-9_-]+$/;

class SecretError extends ApiError {}

export type SealPurpose = 'connector' | 'model';

const PURPOSES: Record<SealPurpose, string> = { connector: 'metro-connector/v1', model: 'metro-model/v1' };

const unreadable = (purpose: SealPurpose): SecretError => new SecretError(`a ${purpose} secret could not be opened with this key`, 500);

const aadOf = (purpose: SealPurpose, owner: string, id: string): Buffer => Buffer.from(`${PURPOSES[purpose]}\n${owner}\n${id}`, 'utf8');

export function connectorsKeyOf(text: string): Buffer | null {
  const key = Buffer.from(text, 'base64');
  return key.length === KEY_BYTES && key.toString('base64') === text ? key : null;
}

export function sealSecret(key: Buffer, owner: string, id: string, value: unknown, purpose: SealPurpose = 'connector'): string {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  if (plain.length > SECRET_MAX) throw new SecretError(`${purpose} settings are too large to keep`, 413);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(purpose, owner, id));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
}

export function openSecret(key: Buffer, owner: string, id: string, sealed: string, purpose: SealPurpose = 'connector'): unknown {
  const [version, blob, extra] = sealed.split('.');
  if (version !== VERSION || blob === undefined || extra !== undefined || !BLOB_RE.test(blob)) throw unreadable(purpose);
  const raw = Buffer.from(blob, 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) throw unreadable(purpose);
  const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(aadOf(purpose, owner, id));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw unreadable(purpose);
  }
  return JSON.parse(plain.toString('utf8')) as unknown;
}
