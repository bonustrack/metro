import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { CodexSecret } from './model-secret.js';

export const CODEX_ISSUER = 'https://auth.openai.com';
export const OPENAI_API = 'https://api.openai.com/v1';
export const CODEX_CLI_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';

const PROFILE_CLAIM = 'https://api.openai.com/profile';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const DEFAULT_TTL_MS = 60 * 60_000;
const TOKEN_TIMEOUT_MS = 20_000;
const DEAD_GRANTS = new Set(['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']);

export class CodexTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export const isDeadGrant = (err: unknown): boolean => err instanceof CodexTokenError && (err.status === 400 || err.status === 401) && DEAD_GRANTS.has(err.code);

export interface Encoded {
  type: string;
  body: string;
}

export const asForm = (fields: Record<string, string>): Encoded => ({ type: 'application/x-www-form-urlencoded', body: new URLSearchParams(fields).toString() });

const asJson = (fields: Record<string, string>): Encoded => ({ type: 'application/json', body: JSON.stringify(fields) });

export const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

function errorCode(body: Record<string, unknown>): string {
  if (typeof body.error === 'string') return body.error;
  return isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : '';
}

function errorText(body: Record<string, unknown>, raw: string): string {
  const nested = isRecord(body.error) ? nonEmpty(body.error.message) : null;
  return nonEmpty(body.error_description) ?? nested ?? nonEmpty(body.error) ?? raw.slice(0, 300);
}

function parsed(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export async function tokenCall(url: string, sent: Encoded, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': sent.type, accept: 'application/json' },
    body: sent.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const raw = await res.text();
  const body = parsed(raw);
  if (!res.ok) throw new CodexTokenError(`OpenAI refused the token request (${String(res.status)}): ${errorText(body, raw)}`, res.status, errorCode(body));
  return body;
}

export interface Grant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function grantOf(body: Record<string, unknown>, keptRefresh: string, now: number): Grant {
  const accessToken = nonEmpty(body.access_token) ?? '';
  const refreshToken = nonEmpty(body.refresh_token) ?? keptRefresh;
  if (accessToken === '' || refreshToken === '') throw new CodexTokenError('OpenAI returned no usable tokens; sign in again', 502, '');
  const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1000 : DEFAULT_TTL_MS;
  return { accessToken, refreshToken, expiresAt: now + ttl };
}

export function decodeJwtPayload(jwt: unknown): Record<string, unknown> {
  const part = (typeof jwt === 'string' ? jwt : '').split('.')[1] ?? '';
  return parsed(Buffer.from(part, 'base64url').toString('utf8'));
}

export function emailOf(claims: Record<string, unknown>): string | null {
  const profile = isRecord(claims[PROFILE_CLAIM]) ? claims[PROFILE_CLAIM] : {};
  return nonEmpty(claims.email) ?? nonEmpty(profile.email);
}

export interface CodeClaims {
  accountId: string | null;
  email: string | null;
  plan: string | null;
}

export function codeClaimsOf(idToken: unknown): CodeClaims {
  const payload = decodeJwtPayload(idToken);
  const auth = isRecord(payload[AUTH_CLAIM]) ? payload[AUTH_CLAIM] : {};
  return { accountId: nonEmpty(auth.chatgpt_account_id), email: emailOf(payload), plan: nonEmpty(auth.chatgpt_plan_type) };
}

export interface Refreshed {
  secret: CodexSecret;
  email: string | null;
  plan: string | null;
}

async function refreshChatgpt(secret: CodexSecret, fetchImpl: FetchLike, now: number, issuer: string): Promise<Refreshed> {
  const body = await tokenCall(
    `${issuer}/api/accounts/oauth/token`,
    asForm({ grant_type: 'refresh_token', client_id: secret.clientId ?? '', refresh_token: secret.refreshToken, resource: OPENAI_API }),
    fetchImpl,
  );
  return { secret: { ...secret, ...grantOf(body, secret.refreshToken, now) }, email: emailOf(decodeJwtPayload(body.id_token)), plan: null };
}

async function refreshCode(secret: CodexSecret, fetchImpl: FetchLike, now: number, issuer: string): Promise<Refreshed> {
  const body = await tokenCall(`${issuer}/oauth/token`, asJson({ client_id: CODEX_CLI_CLIENT, grant_type: 'refresh_token', refresh_token: secret.refreshToken }), fetchImpl);
  const claims = codeClaimsOf(body.id_token);
  const accountId = claims.accountId ?? secret.accountId;
  return { secret: { ...secret, ...grantOf(body, secret.refreshToken, now), ...(accountId === undefined ? {} : { accountId }) }, email: claims.email, plan: claims.plan };
}

export const refreshCodex = (secret: CodexSecret, fetchImpl: FetchLike, now: number, issuer = CODEX_ISSUER): Promise<Refreshed> =>
  secret.method === 'code' ? refreshCode(secret, fetchImpl, now, issuer) : refreshChatgpt(secret, fetchImpl, now, issuer);
