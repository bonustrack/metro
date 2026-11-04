import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';

const CLIENT_PREFIX = 'mc1';
const SIGNATURE_BYTES = 16;
const REDIRECTS_MAX = 5;
const REDIRECT_MAX = 2048;
const REDIRECTS_TOTAL_MAX = 3000;
export const CLIENT_NAME_MAX = 64;
const DEFAULT_NAME = 'An MCP client';
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:$/;

export interface OauthClient {
  name: string;
  redirectUris: string[];
  issuedAt: number;
}

export const clientKeyOf = (connectorsKey: Buffer): Buffer => Buffer.from(hkdfSync('sha256', connectorsKey, Buffer.alloc(0), 'metro-mcp-oauth-client/v1', 32));

const signatureOf = (key: Buffer, payload: string): Buffer => createHmac('sha256', key).update(`${CLIENT_PREFIX}.${payload}`, 'utf8').digest().subarray(0, SIGNATURE_BYTES);

function parsedUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function redirectAllowed(raw: string): boolean {
  if (raw.length === 0 || raw.length > REDIRECT_MAX || raw.includes('#')) return false;
  const url = parsedUrl(raw);
  if (url === null || url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return url.hostname !== '';
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return SCHEME_RE.test(url.protocol) && !BLOCKED_SCHEMES.has(url.protocol);
}

function withoutPort(raw: string): string | null {
  const url = parsedUrl(raw);
  if (url === null || url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return null;
  url.port = '';
  return url.toString();
}

export function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  const loose = withoutPort(registered);
  return loose !== null && loose === withoutPort(given);
}

export const cleanName = (raw: unknown): string => {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}]/gu, '').trim().slice(0, CLIENT_NAME_MAX).trim() : '';
  return name === '' ? DEFAULT_NAME : name;
};

export function clientFromRegistration(body: unknown, now: number): OauthClient | string {
  const uris = isRecord(body) ? body.redirect_uris : undefined;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > REDIRECTS_MAX) return `redirect_uris must list 1 to ${String(REDIRECTS_MAX)} addresses.`;
  const redirectUris = uris.filter((uri): uri is string => typeof uri === 'string');
  if (redirectUris.length !== uris.length || !redirectUris.every(redirectAllowed)) return 'Each redirect address must be https, a loopback http address or an app scheme, with no fragment.';
  if (redirectUris.join('').length > REDIRECTS_TOTAL_MAX) return 'The redirect addresses are too long.';
  return { name: cleanName(isRecord(body) ? body.client_name : undefined), redirectUris, issuedAt: Math.floor(now / 1000) };
}

export function clientIdOf(key: Buffer, client: OauthClient): string {
  const payload = Buffer.from(JSON.stringify({ n: client.name, r: client.redirectUris, t: client.issuedAt }), 'utf8').toString('base64url');
  return `${CLIENT_PREFIX}.${payload}.${signatureOf(key, payload).toString('base64url')}`;
}

function clientOfPayload(payload: string): OauthClient | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(value) || !Array.isArray(value.r) || typeof value.t !== 'number') return null;
    const redirectUris = value.r.filter((uri): uri is string => typeof uri === 'string');
    return redirectUris.length === 0 ? null : { name: cleanName(value.n), redirectUris, issuedAt: value.t };
  } catch {
    return null;
  }
}

export function clientOf(key: Buffer, clientId: string): OauthClient | null {
  const [prefix, payload, signature, extra] = clientId.split('.');
  if (prefix !== CLIENT_PREFIX || payload === undefined || signature === undefined || extra !== undefined) return null;
  const given = Buffer.from(signature, 'base64url');
  const expected = signatureOf(key, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return clientOfPayload(payload);
}
