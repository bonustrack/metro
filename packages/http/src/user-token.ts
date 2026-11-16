import type { IncomingMessage } from 'node:http';
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';

export const METRO_ISSUER = 'https://api.metro.box';
const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;
export const isOrganizationId = (value: string): boolean => ORG_RE.test(value);
const SKEW_S = 60;
const REFETCH_COOLDOWN_MS = 60_000;
const FETCH_MS = 10_000;
const KEYS_MAX_AGE_MS = 60 * 60_000;
const LIFETIME_MAX_S = 60 * 60;
const IAT_AHEAD_S = 5 * 60;

export interface Session {
  userId: string;
  sessionId: string;
  organization: string | null;
  role: string | null;
  expiresAt: number;
}

export interface KeyStore {
  read: () => string | null;
  write: (text: string) => void;
}

export interface KeySource {
  keyFor: (kid: string, now: number) => Promise<KeyObject | null>;
}

export const filled = (value: string | undefined): string | null => {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
};

export const metroAuthBase = (env: NodeJS.ProcessEnv = process.env): string => filled(env.METRO_AUTH_BASE) ?? METRO_ISSUER;
export const metroJwksUrl = (base = METRO_ISSUER): string => `${base}/.well-known/jwks.json`;

function jwksKeys(text: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const parsed: unknown = JSON.parse(text);
  const list = isRecord(parsed) ? parsed.keys : undefined;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list) {
    if (!isRecord(jwk) || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
    } catch {
      continue;
    }
  }
  return keys;
}

export class JwksKeys implements KeySource {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private quietUntil = 0;
  private loaded = false;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly store?: KeyStore,
    private readonly maxAgeMs = Number.POSITIVE_INFINITY,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const cached = this.store?.read() ?? null;
    if (cached !== null) this.keys = jwksKeys(cached);
  }

  private async fetchKeys(now: number): Promise<void> {
    const res = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_MS) });
    if (!res.ok) throw new Error(`the signing keys answered ${String(res.status)}`);
    const text = await res.text();
    const keys = jwksKeys(text);
    if (keys.size === 0) throw new Error('the signing keys answered no RSA key');
    this.keys = keys;
    this.fetchedAt = now;
    this.store?.write(text);
  }

  async refresh(now = Date.now()): Promise<boolean> {
    this.load();
    if (now < this.quietUntil) return false;
    this.pending ??= this.fetchKeys(now)
      .catch((err: unknown) => {
        this.quietUntil = now + REFETCH_COOLDOWN_MS;
        throw err;
      })
      .finally(() => {
        this.pending = null;
      });
    await this.pending;
    return true;
  }

  async keyFor(kid: string, now = Date.now()): Promise<KeyObject | null> {
    this.load();
    const held = this.keys.get(kid);
    if (held !== undefined && now - this.fetchedAt <= this.maxAgeMs) return held;
    const fetched = await this.refresh(now).catch(() => false);
    const key = this.keys.get(kid);
    if (key === undefined && fetched) this.quietUntil = now + REFETCH_COOLDOWN_MS;
    return key ?? null;
  }
}

export const metroKeys = (env: NodeJS.ProcessEnv = process.env, store?: KeyStore): JwksKeys =>
  new JwksKeys(metroJwksUrl(metroAuthBase(env)), store, KEYS_MAX_AGE_MS);

const b64url = (text: string): Buffer => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function jsonPart(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(b64url(text).toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function sessionOf(claims: Record<string, unknown>, now: number): Session | null {
  const exp = num(claims.exp);
  const userId = str(claims.sub);
  const sessionId = str(claims.sid);
  if (exp === null || userId === null || sessionId === null) return null;
  if (exp * 1000 < now - SKEW_S * 1000) return null;
  return { userId, sessionId, organization: str(claims.org_id), role: str(claims.role), expiresAt: exp * 1000 };
}

function metroShaped(header: Record<string, unknown>, claims: Record<string, unknown>, now: number): boolean {
  const iat = num(claims.iat);
  const exp = num(claims.exp);
  if (claims.iss !== METRO_ISSUER || header.typ !== 'JWT' || iat === null || exp === null) return false;
  return exp - iat <= LIFETIME_MAX_S && iat * 1000 <= now + IAT_AHEAD_S * 1000;
}

interface Parts {
  signed: string;
  claims: Record<string, unknown>;
  signature: Buffer;
  kid: string;
}

function parseToken(token: string, now: number): Parts | null {
  const [head, body, sig] = token.split('.');
  if (head === undefined || body === undefined || sig === undefined) return null;
  const header = jsonPart(head);
  const claims = jsonPart(body);
  if (header?.alg !== 'RS256' || claims === null) return null;
  const kid = str(header.kid);
  if (kid === null || !metroShaped(header, claims, now)) return null;
  return { signed: `${head}.${body}`, claims, signature: b64url(sig), kid };
}

export async function verifyToken(token: string, keys: KeySource, now = Date.now()): Promise<Session | null> {
  const parts = parseToken(token, now);
  if (parts === null) return null;
  const key = await keys.keyFor(parts.kid, now).catch(() => null);
  if (key === null || !verify('sha256', Buffer.from(parts.signed), key, parts.signature)) return null;
  return sessionOf(parts.claims, now);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' && token?.includes('.') === true ? token : null;
}

export async function bearerSession(req: IncomingMessage, keys: KeySource): Promise<Session | null> {
  const token = bearerToken(req);
  return token === null ? null : verifyToken(token, keys);
}
