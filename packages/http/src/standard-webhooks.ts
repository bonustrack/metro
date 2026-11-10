import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const TOLERANCE_MS = 5 * 60_000;
const SECRET_RE = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const SECRET_BYTES = 32;
const SECRET_MIN = 24;
const SECRET_MAX = 64;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const SUBSCRIPTION_RE = /^[\x21-\x7e]{1,128}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;
const SIGNATURE_MAX = 4096;
const SIGNATURES_MAX = 16;
const VERSION = 'v1,';

export interface WebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export const newWebhookSecret = (): string => `whsec_${randomBytes(SECRET_BYTES).toString('base64')}`;

function secretBytes(secret: string): Buffer | null {
  const encoded = SECRET_RE.exec(secret)?.[1];
  if (encoded === undefined) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length >= SECRET_MIN && bytes.length <= SECRET_MAX && bytes.toString('base64') === encoded ? bytes : null;
}

const digest = (key: Buffer, id: string, timestamp: string, body: Buffer | string): Buffer => createHmac('sha256', key).update(`${id}.${timestamp}.`, 'utf8').update(body).digest();

export function webhookSignature(secret: string, id: string, timestamp: string | number, body: Buffer | string): string {
  const key = secretBytes(secret);
  if (key === null) throw new Error('A webhook secret is whsec_ followed by 24 to 64 bytes in base64.');
  return `${VERSION}${digest(key, id, String(timestamp), body).toString('base64')}`;
}

const one = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers[name];
  return typeof value === 'string' ? value : '';
};

export function webhookHeadersOf(headers: IncomingHttpHeaders): WebhookHeaders | null {
  const id = one(headers, 'webhook-id');
  const timestamp = one(headers, 'webhook-timestamp');
  const signature = one(headers, 'webhook-signature');
  if (!ID_RE.test(id) || !TIMESTAMP_RE.test(timestamp) || !SUBSCRIPTION_RE.test(one(headers, 'x-mcp-subscription-id'))) return null;
  return signature === '' || signature.length > SIGNATURE_MAX ? null : { id, timestamp, signature };
}

export const webhookFresh = (headers: Pick<WebhookHeaders, 'timestamp'>, now: number): boolean => Math.abs(now - Number(headers.timestamp) * 1000) <= TOLERANCE_MS;

export function webhookSigned(secret: string, headers: WebhookHeaders, body: Buffer): boolean {
  const key = secretBytes(secret);
  if (key === null) return false;
  const expected = digest(key, headers.id, headers.timestamp, body);
  return headers.signature
    .split(' ')
    .filter((part) => part.startsWith(VERSION))
    .slice(0, SIGNATURES_MAX)
    .some((part) => {
      const given = Buffer.from(part.slice(VERSION.length), 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
