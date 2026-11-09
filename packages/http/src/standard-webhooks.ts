import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

const SECRET_RE = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const SECRET_BYTES = 32;
const SECRET_MIN = 24;
const SECRET_MAX = 64;
const ID_MAX = 512;
const SIGNATURE_MAX = 4096;
const TIMESTAMP_RE = /^\d{1,12}$/;

export interface WebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
  subscription: string | null;
}

export type WebhookCheck = 'ok' | 'stale' | 'invalid';

export const newWebhookSecret = (): string => `whsec_${randomBytes(SECRET_BYTES).toString('base64')}`;

function secretBytes(secret: string): Buffer | null {
  const encoded = SECRET_RE.exec(secret)?.[1];
  if (encoded === undefined) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length >= SECRET_MIN && bytes.length <= SECRET_MAX && bytes.toString('base64') === encoded ? bytes : null;
}

export const isWebhookSecret = (secret: string): boolean => secretBytes(secret) !== null;

function digest(key: Buffer, id: string, timestamp: string, body: Buffer | string): Buffer {
  return createHmac('sha256', key).update(`${id}.${timestamp}.`, 'utf8').update(body).digest();
}

export function webhookSignature(secret: string, id: string, timestamp: string, body: Buffer | string): string {
  const key = secretBytes(secret);
  if (key === null) throw new Error('A webhook secret is whsec_ followed by 24 to 64 bytes in base64.');
  return `v1,${digest(key, id, timestamp, body).toString('base64')}`;
}

const header = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
};

export function webhookHeadersOf(headers: IncomingHttpHeaders): WebhookHeaders | null {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (id === null || timestamp === null || signature === null || id.length > ID_MAX || signature.length > SIGNATURE_MAX) return null;
  return { id, timestamp, signature, subscription: header(headers, 'x-mcp-subscription-id') };
}

export function checkWebhook(secret: string, headers: WebhookHeaders, body: Buffer, now: number): WebhookCheck {
  const key = secretBytes(secret);
  if (key === null || !TIMESTAMP_RE.test(headers.timestamp)) return 'invalid';
  if (Math.abs(now - Number(headers.timestamp) * 1000) > WEBHOOK_TOLERANCE_MS) return 'stale';
  const expected = digest(key, headers.id, headers.timestamp, body);
  for (const part of headers.signature.split(' ')) {
    if (!part.startsWith('v1,')) continue;
    const given = Buffer.from(part.slice(3), 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return 'ok';
  }
  return 'invalid';
}
