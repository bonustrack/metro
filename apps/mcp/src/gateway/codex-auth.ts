import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../daemon/is-record.js';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_REDIRECT = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PENDING_TTL_MS = 10 * 60_000;
export const ACCESS_TOKEN_TTL_MS = 55 * 60_000;

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  email: string | null;
  plan: string | null;
  savedAt: string;
}

export class CodexAuthError extends Error {}

interface Pending {
  verifier: string;
  at: number;
}

const pending = new Map<string, Pending>();

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(state: string, challenge: string, issuer = CODEX_ISSUER): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
  });
  return `${issuer}/oauth/authorize?${query.toString()}`;
}

function sweep(now: number): void {
  for (const [state, entry] of pending) if (now - entry.at > PENDING_TTL_MS) pending.delete(state);
}

export function beginLogin(issuer = CODEX_ISSUER, now = Date.now()): { url: string; state: string } {
  sweep(now);
  const { verifier, challenge } = newPkce();
  const state = b64url(randomBytes(24));
  pending.set(state, { verifier, at: now });
  return { url: authorizeUrl(state, challenge, issuer), state };
}

export function parseCallback(raw: string): { code: string; state: string } {
  const text = raw.trim();
  let query: URLSearchParams;
  try {
    query = new URL(text).searchParams;
  } catch {
    query = new URLSearchParams(text.replace(/^\?/, ''));
  }
  const code = query.get('code')?.trim() ?? '';
  const state = query.get('state')?.trim() ?? '';
  if (code === '' || state === '')
    throw new CodexAuthError('paste the whole address the browser landed on; it carries code= and state=');
  return { code, state };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function claimsOf(idToken: string): { accountId: string | null; email: string | null; plan: string | null } {
  const payload = decodeJwtPayload(idToken);
  const auth = isRecord(payload[AUTH_CLAIM]) ? payload[AUTH_CLAIM] : {};
  return { accountId: text(auth.chatgpt_account_id), email: text(payload.email), plan: text(auth.chatgpt_plan_type) };
}

interface TokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
}

const EMPTY_TOKENS: CodexTokens = { accessToken: '', refreshToken: '', idToken: '', accountId: '', email: null, plan: null, savedAt: '' };

function assertUsable(next: CodexTokens): CodexTokens {
  if (next.accessToken === '' || next.refreshToken === '') throw new CodexAuthError('the token endpoint returned no usable tokens');
  if (next.accountId === '') throw new CodexAuthError('the id token carries no ChatGPT account id; sign in with a ChatGPT account that has Codex');
  return next;
}

const pick = (fresh: string | null, kept: string | null): string | null => fresh ?? kept;

export function tokensFrom(body: unknown, previous: CodexTokens | null, now = new Date()): CodexTokens {
  const res = (isRecord(body) ? body : {}) as TokenResponse;
  const kept = previous ?? EMPTY_TOKENS;
  const idToken = pick(text(res.id_token), kept.idToken) ?? '';
  const claims = claimsOf(idToken);
  return assertUsable({
    accessToken: text(res.access_token) ?? '',
    refreshToken: pick(text(res.refresh_token), kept.refreshToken) ?? '',
    idToken,
    accountId: pick(claims.accountId, kept.accountId) ?? '',
    email: pick(claims.email, kept.email),
    plan: pick(claims.plan, kept.plan),
    savedAt: now.toISOString(),
  });
}

async function tokenCall(issuer: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(`${issuer}/oauth/token`, init);
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) detail = text(parsed.error_description) ?? text(parsed.error) ?? detail;
    } catch {
      detail = raw.slice(0, 300);
    }
    throw new CodexAuthError(`OpenAI refused the token request (${String(res.status)}): ${detail}`);
  }
  return JSON.parse(raw) as unknown;
}

export async function finishLogin(
  callback: string,
  issuer = CODEX_ISSUER,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<CodexTokens> {
  sweep(now);
  const { code, state } = parseCallback(callback);
  const entry = pending.get(state);
  if (entry === undefined) throw new CodexAuthError('this sign-in link has expired or was started elsewhere; press Connect again');
  pending.delete(state);
  return exchangeCode(issuer, code, entry.verifier, CODEX_REDIRECT, fetchImpl, now);
}

export async function exchangeCode(
  issuer: string,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await tokenCall(
    issuer,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() },
    fetchImpl,
  );
  return tokensFrom(res, null, new Date(now));
}

export async function refreshTokens(previous: CodexTokens, issuer = CODEX_ISSUER, fetchImpl: typeof fetch = fetch): Promise<CodexTokens> {
  const res = await tokenCall(
    issuer,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: previous.refreshToken }),
    },
    fetchImpl,
  );
  return tokensFrom(res, previous);
}

export const tokensStale = (tokens: CodexTokens, now = Date.now()): boolean =>
  now - Date.parse(tokens.savedAt) > ACCESS_TOKEN_TTL_MS;

function readAuthFile(home: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'));
  } catch {
    throw new CodexAuthError('no Codex CLI login on this machine (~/.codex/auth.json); run codex login there first, or connect here');
  }
  return isRecord(raw) ? raw : {};
}

export function readCodexCliAuth(home = homedir()): CodexTokens {
  const raw = readAuthFile(home);
  if (!isRecord(raw.tokens)) throw new CodexAuthError('~/.codex/auth.json holds no ChatGPT tokens (an API-key login cannot be reused here)');
  const stored = raw.tokens;
  const idToken = text(stored.id_token) ?? '';
  const claims = claimsOf(idToken);
  const found: CodexTokens = {
    accessToken: text(stored.access_token) ?? '',
    refreshToken: text(stored.refresh_token) ?? '',
    idToken,
    accountId: text(stored.account_id) ?? claims.accountId ?? '',
    email: claims.email,
    plan: claims.plan,
    savedAt: text(raw.last_refresh) ?? new Date(0).toISOString(),
  };
  if ([found.accessToken, found.refreshToken, found.accountId].includes('')) throw new CodexAuthError('~/.codex/auth.json is missing a token or the account id');
  return found;
}
