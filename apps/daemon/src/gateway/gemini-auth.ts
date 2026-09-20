import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';

export const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GEMINI_CLIENT_SECRET = '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';
export const GEMINI_AUTH_BASE = 'https://accounts.google.com';
export const GEMINI_TOKEN_BASE = 'https://oauth2.googleapis.com';
export const GEMINI_REDIRECT = 'https://codeassist.google.com/authcode';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
const PENDING_TTL_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 55 * 60_000;

export interface GeminiTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string | null;
  project: string;
  tier: string | null;
  savedAt: string;
}

export class GeminiAuthError extends Error {}

interface Pending {
  verifier: string;
  at: number;
}

const pending = new Map<string, Pending>();

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(state: string, challenge: string, base = GEMINI_AUTH_BASE): string {
  const params = new URLSearchParams({
    client_id: GEMINI_CLIENT_ID,
    redirect_uri: GEMINI_REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${base}/o/oauth2/v2/auth?${params.toString()}`;
}

function sweep(now: number): void {
  for (const [state, entry] of pending) if (now - entry.at > PENDING_TTL_MS) pending.delete(state);
}

export function beginLogin(base = GEMINI_AUTH_BASE, now = Date.now()): { url: string; state: string } {
  sweep(now);
  const { verifier, challenge } = newPkce();
  const state = b64url(randomBytes(16));
  pending.set(state, { verifier, at: now });
  return { url: authorizeUrl(state, challenge, base), state };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const refusalIn = (body: Record<string, unknown>): string => text(body.error_description) ?? text(body.error) ?? 'Google answered without an access token';

function grantedTokens(body: unknown, previous: GeminiTokens | null): { accessToken: string; refreshToken: string; ttl: number } {
  if (!isRecord(body)) throw new GeminiAuthError('Google answered without tokens');
  const accessToken = text(body.access_token);
  if (accessToken === null) throw new GeminiAuthError(refusalIn(body));
  const refreshToken = text(body.refresh_token) ?? previous?.refreshToken ?? '';
  if (refreshToken === '') throw new GeminiAuthError('Google issued no refresh token; sign in again');
  return { accessToken, refreshToken, ttl: typeof body.expires_in === 'number' ? body.expires_in * 1000 : DEFAULT_TTL_MS };
}

function tokensOf(body: unknown, previous: GeminiTokens | null, now: number): GeminiTokens {
  const granted = grantedTokens(body, previous);
  return {
    accessToken: granted.accessToken,
    refreshToken: granted.refreshToken,
    expiresAt: now + granted.ttl,
    email: previous?.email ?? null,
    project: previous?.project ?? '',
    tier: previous?.tier ?? null,
    savedAt: new Date(now).toISOString(),
  };
}

async function tokenCall(form: Record<string, string>, base: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GeminiAuthError(`could not reach Google: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new GeminiAuthError(isRecord(body) ? (text(body.error_description) ?? text(body.error) ?? `Google answered ${String(res.status)}`) : `Google answered ${String(res.status)}`);
  return body;
}

export async function exchangeCode(code: string, state: string, base = GEMINI_TOKEN_BASE, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GeminiTokens> {
  sweep(now);
  const entry = pending.get(state);
  if (entry === undefined) throw new GeminiAuthError('that sign-in has expired; start it again');
  pending.delete(state);
  const trimmed = code.trim();
  if (trimmed === '') throw new GeminiAuthError('paste the code Google showed');
  const body = await tokenCall(
    { client_id: GEMINI_CLIENT_ID, client_secret: GEMINI_CLIENT_SECRET, grant_type: 'authorization_code', code: trimmed, code_verifier: entry.verifier, redirect_uri: GEMINI_REDIRECT },
    base,
    fetchImpl,
  );
  return tokensOf(body, null, now);
}

export async function refreshTokens(previous: GeminiTokens, base = GEMINI_TOKEN_BASE, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GeminiTokens> {
  const body = await tokenCall(
    { client_id: GEMINI_CLIENT_ID, client_secret: GEMINI_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: previous.refreshToken },
    base,
    fetchImpl,
  );
  return tokensOf(body, previous, now);
}

export const tokensStale = (tokens: GeminiTokens, now = Date.now()): boolean => tokens.expiresAt - EXPIRY_MARGIN_MS <= now;

export async function userEmail(tokens: GeminiTokens, base = 'https://www.googleapis.com', fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${base}/oauth2/v2/userinfo`, { headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const body: unknown = await res.json().catch(() => null);
    return res.ok && isRecord(body) ? text(body.email) : null;
  } catch {
    return null;
  }
}

export function tokensFromDisk(raw: unknown): GeminiTokens | null {
  if (!isRecord(raw)) return null;
  const accessToken = text(raw.accessToken);
  const refreshToken = text(raw.refreshToken);
  if (accessToken === null || refreshToken === null) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    email: text(raw.email),
    project: text(raw.project) ?? '',
    tier: text(raw.tier),
    savedAt: text(raw.savedAt) ?? '',
  };
}
