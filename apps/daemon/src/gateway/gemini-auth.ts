import { isRecord } from '@metro-labs/core/is-record';
import { PendingLogins } from './pkce.js';
import { nonEmpty } from './text.js';

export const GEMINI_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const GEMINI_CLIENT_SECRET = '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';
export const GEMINI_AUTH_BASE = 'https://accounts.google.com';
export const GEMINI_TOKEN_BASE = 'https://oauth2.googleapis.com';
export const GEMINI_REDIRECT = 'http://localhost:51121/oauth-callback';
const SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');
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

const pending = new PendingLogins(16);

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

export function beginLogin(base = GEMINI_AUTH_BASE, now = Date.now()): { url: string; state: string } {
  const { state, challenge } = pending.begin(now);
  return { url: authorizeUrl(state, challenge, base), state };
}


const refusalIn = (body: Record<string, unknown>): string => nonEmpty(body.error_description) ?? nonEmpty(body.error) ?? 'Google answered without an access token';

function grantedTokens(body: unknown, previous: GeminiTokens | null): { accessToken: string; refreshToken: string; ttl: number } {
  if (!isRecord(body)) throw new GeminiAuthError('Google answered without tokens');
  const accessToken = nonEmpty(body.access_token);
  if (accessToken === null) throw new GeminiAuthError(refusalIn(body));
  const refreshToken = nonEmpty(body.refresh_token) ?? previous?.refreshToken ?? '';
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
  if (!res.ok) throw new GeminiAuthError(isRecord(body) ? (nonEmpty(body.error_description) ?? nonEmpty(body.error) ?? `Google answered ${String(res.status)}`) : `Google answered ${String(res.status)}`);
  return body;
}

export function codeIn(pasted: string, state: string): string {
  const trimmed = pasted.trim();
  if (trimmed === '') throw new GeminiAuthError('paste the address the browser landed on, or the code in it');
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GeminiAuthError('that is not a full address');
  }
  const code = url.searchParams.get('code') ?? '';
  const carried = url.searchParams.get('state');
  if (code === '') throw new GeminiAuthError(`that address carries no code${url.searchParams.get('error') === null ? '' : ` (Google said ${url.searchParams.get('error') ?? ''})`}`);
  if (carried !== null && carried !== state) throw new GeminiAuthError('that address belongs to another sign-in; start again and paste the new one');
  return code;
}

export async function exchangeCode(pasted: string, state: string, base = GEMINI_TOKEN_BASE, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GeminiTokens> {
  const verifier = pending.take(state, now);
  if (verifier === null) throw new GeminiAuthError('that sign-in has expired; start it again');
  const code = codeIn(pasted, state);
  const body = await tokenCall(
    { client_id: GEMINI_CLIENT_ID, client_secret: GEMINI_CLIENT_SECRET, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: GEMINI_REDIRECT },
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
    return res.ok && isRecord(body) ? nonEmpty(body.email) : null;
  } catch {
    return null;
  }
}

export function tokensFromDisk(raw: unknown): GeminiTokens | null {
  if (!isRecord(raw)) return null;
  const accessToken = nonEmpty(raw.accessToken);
  const refreshToken = nonEmpty(raw.refreshToken);
  if (accessToken === null || refreshToken === null) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    email: nonEmpty(raw.email),
    project: nonEmpty(raw.project) ?? '',
    tier: nonEmpty(raw.tier),
    savedAt: nonEmpty(raw.savedAt) ?? '',
  };
}
