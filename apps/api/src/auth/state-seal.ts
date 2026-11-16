import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';

const LABEL = 'metro-auth-state/v1';
const PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STATE_TTL_MS = 10 * 60_000;
const STATE_MAX = 4096;

export function stateKeyFrom(signer: KeyObject | null, connectorsKey: Buffer | null): Buffer | null {
  const material = signer === null ? connectorsKey : signer.export({ type: 'pkcs8', format: 'der' });
  return material === null ? null : Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), LABEL, 32));
}

const bootKey = randomBytes(32);

export function stateKeyOr(key: Buffer | null | undefined): Buffer {
  return key ?? bootKey;
}

export function announceStateKey(key: Buffer | null): void {
  if (key === null) log.warn('api: neither METRO_AUTH_SIGNING_KEY nor METRO_CONNECTORS_KEY is set, so a sign-in only finishes on the machine that started it');
}

export function sealState(key: Buffer, value: Record<string, unknown>, now: number): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(LABEL));
  const data = Buffer.concat([cipher.update(JSON.stringify({ ...value, exp: now + STATE_TTL_MS }), 'utf8'), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
}

function opened(key: Buffer, raw: Buffer): unknown {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(LABEL));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

export function openState(key: Buffer, sealed: string, now: number): Record<string, unknown> | null {
  if (!sealed.startsWith(PREFIX) || sealed.length > STATE_MAX) return null;
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  const value = opened(key, raw);
  if (!isRecord(value) || typeof value.exp !== 'number' || value.exp <= now) return null;
  return value;
}
