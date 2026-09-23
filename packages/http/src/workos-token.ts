import type { IncomingMessage } from 'node:http';
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

const WORKOS_API = 'https://api.workos.com';
const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;
export const isOrganizationId = (value: string): boolean => ORG_RE.test(value);
export const DEFAULT_CLIENT_ID = 'client_01M2TJJJ6RM9CT081QB4XZK3G2';
const SKEW_S = 60;
const REFETCH_COOLDOWN_MS = 60_000;
const FETCH_MS = 10_000;

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

export const filled = (value: string | undefined): string | null => {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
};

export const clientId = (env: NodeJS.ProcessEnv = process.env): string => filled(env.WORKOS_CLIENT_ID) ?? DEFAULT_CLIENT_ID;
export const workosBase = (env: NodeJS.ProcessEnv = process.env): string => filled(env.WORKOS_API_BASE) ?? WORKOS_API;
export const jwksUrl = (id: string, base = WORKOS_API): string => `${base}/sso/jwks/${id}`;

function jwksKeys(text: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const parsed: unknown = JSON.parse(text);
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list) {
    if (typeof jwk !== 'object' || jwk === null) continue;
    const { kid, kty } = jwk as { kid?: unknown; kty?: unknown };
    if (typeof kid !== 'string' || kty !== 'RSA') continue;
    try {
      keys.set(kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
    } catch {
      continue;
    }
  }
  return keys;
}

export class SigningKeys {
  private keys = new Map<string, KeyObject>();
  private lastMiss = 0;
  private loaded = false;

  constructor(
    private readonly url: string,
    private readonly store?: KeyStore,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const cached = this.store?.read() ?? null;
    if (cached !== null) this.keys = jwksKeys(cached);
  }

  private async refresh(now: number): Promise<void> {
    if (now - this.lastMiss < REFETCH_COOLDOWN_MS) return;
    const res = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_MS) });
    if (!res.ok) throw new Error(`the signing keys answered ${String(res.status)}`);
    const text = await res.text();
    const keys = jwksKeys(text);
    if (keys.size === 0) throw new Error('the signing keys answered no RSA key');
    this.keys = keys;
    this.store?.write(text);
  }

  async keyFor(kid: string, now = Date.now()): Promise<KeyObject | null> {
    this.load();
    const held = this.keys.get(kid);
    if (held !== undefined) return held;
    await this.refresh(now);
    const fetched = this.keys.get(kid);
    if (fetched === undefined) this.lastMiss = now;
    return fetched ?? null;
  }
}

const b64url = (text: string): Buffer => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function jsonPart(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(b64url(text).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const issuedBy = (iss: unknown, issuer: string): boolean => typeof iss === 'string' && (iss === issuer || iss.startsWith(`${issuer}/`));

function sessionOf(claims: Record<string, unknown>, issuer: string, now: number): Session | null {
  const exp = typeof claims.exp === 'number' ? claims.exp : null;
  const userId = str(claims.sub);
  const sessionId = str(claims.sid);
  if (!issuedBy(claims.iss, issuer) || exp === null || userId === null || sessionId === null) return null;
  if (exp * 1000 < now - SKEW_S * 1000) return null;
  return { userId, sessionId, organization: str(claims.org_id), role: str(claims.role), expiresAt: exp * 1000 };
}

interface Parts {
  signed: string;
  body: string;
  signature: Buffer;
  kid: string;
}

function parseToken(token: string): Parts | null {
  const [head, body, sig] = token.split('.');
  if (head === undefined || body === undefined || sig === undefined) return null;
  const header = jsonPart(head);
  const kid = str(header?.kid);
  if (header?.alg !== 'RS256' || kid === null) return null;
  return { signed: `${head}.${body}`, body, signature: b64url(sig), kid };
}

export async function verifyToken(token: string, keys: SigningKeys, issuer = WORKOS_API, now = Date.now()): Promise<Session | null> {
  const parts = parseToken(token);
  if (parts === null) return null;
  const key = await keys.keyFor(parts.kid, now).catch(() => null);
  if (key === null || !verify('sha256', Buffer.from(parts.signed), key, parts.signature)) return null;
  const claims = jsonPart(parts.body);
  return claims === null ? null : sessionOf(claims, issuer, now);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' && token?.includes('.') === true ? token : null;
}

export async function bearerSession(req: IncomingMessage, keys: SigningKeys, issuer = WORKOS_API): Promise<Session | null> {
  const token = bearerToken(req);
  return token === null ? null : verifyToken(token, keys, issuer);
}
