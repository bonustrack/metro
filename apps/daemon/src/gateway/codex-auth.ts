import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { ticketStore } from '@metro-labs/core/tickets';
import { agentsDir } from '../agents/files.js';
import { newPkce } from './pkce.js';
import { nonEmpty } from './text.js';

export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_REDIRECT = 'http://127.0.0.1:1455/auth/callback';
export const OPENAI_API = 'https://api.openai.com/v1';
export const NEW_CLIENT = 'dynamic_agent_client';
export const APP_NAME = 'Metro';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CODEX_SIGN_IN = 'Codex is not signed in: sign in with ChatGPT on the Model page.';
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const PROFILE_CLAIM = 'https://api.openai.com/profile';
const HOST_FILE = 'chatgpt-host.json';
const HOST_RE = /^urn:uuid:[0-9a-f-]{36}$/;
const PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const RENEW_BEFORE_MS = 2 * 60_000;
const AGAIN = 'press Continue with ChatGPT again';

export type CodexMethod = 'chatgpt' | 'code';

export interface CodexCredential {
  email: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  savedAt: string;
}

export interface ChatgptTokens extends CodexCredential {
  method: 'chatgpt';
  clientId: string;
  subject: string;
}

export interface CodeTokens extends CodexCredential {
  method: 'code';
  accountId: string;
  plan: string | null;
}

export type CodexTokens = ChatgptTokens | CodeTokens;

export class CodexAuthError extends Error {}

interface Pending {
  verifier: string;
  nonce: string;
  clientId: string | null;
  subject: string | null;
}

const pending = ticketStore<Pending>(PENDING_TTL_MS, 24);

export function chatgptHostId(dir = agentsDir()): string {
  const path = join(dir, HOST_FILE);
  const saved = readJson<unknown>(path, null);
  if (isRecord(saved) && typeof saved.hostId === 'string' && HOST_RE.test(saved.hostId)) return saved.hostId;
  const made = `urn:uuid:${randomUUID()}`;
  writeSecure(path, JSON.stringify({ hostId: made }));
  return made;
}

function returning(previous: ChatgptTokens | null): Record<string, string> {
  if (previous === null) return { client_id: NEW_CLIENT, agent_name_hint: APP_NAME };
  return { client_id: previous.clientId, ...(previous.email === null ? {} : { login_hint: previous.email }) };
}

export function beginLogin(previous: ChatgptTokens | null, hostId: string, issuer = CODEX_ISSUER, now = Date.now()): string {
  const { verifier, challenge } = newPkce();
  const nonce = randomBytes(32).toString('base64url');
  const { ticket: state } = pending.mint({ verifier, nonce, clientId: previous?.clientId ?? null, subject: previous?.subject ?? null }, now);
  const query = new URLSearchParams({
    ...returning(previous),
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: CODEX_REDIRECT,
    scope: SCOPE,
    resource: OPENAI_API,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return `${issuer}/api/accounts/authorize?${query.toString()}`;
}

function queryOf(raw: string): URLSearchParams {
  const text = raw.trim();
  try {
    return new URL(text).searchParams;
  } catch {
    return new URLSearchParams(text.replace(/^\?/, ''));
  }
}

const param = (query: URLSearchParams, name: string): string => query.get(name)?.trim() ?? '';

function assertAllowed(query: URLSearchParams): void {
  const error = param(query, 'error');
  if (error === 'access_denied') throw new CodexAuthError('you did not allow Metro to use your ChatGPT plan, so nothing was saved');
  if (error !== '') throw new CodexAuthError(`ChatGPT stopped the sign-in (${query.get('error_description') ?? error}); ${AGAIN}`);
}

export function parseCallback(raw: string): { code: string; state: string; clientId: string | null } {
  const query = queryOf(raw);
  assertAllowed(query);
  const code = param(query, 'code');
  const state = param(query, 'state');
  if (code === '' || state === '') throw new CodexAuthError('paste the whole address the browser landed on; it carries code= and state=');
  return { code, state, clientId: nonEmpty(param(query, 'client_id')) };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function emailOf(claims: Record<string, unknown>): string | null {
  const profile = isRecord(claims[PROFILE_CLAIM]) ? claims[PROFILE_CLAIM] : {};
  return nonEmpty(claims.email) ?? nonEmpty(profile.email);
}

function identityOf(idToken: unknown, expected: { issuer: string; clientId: string; nonce: string }): { subject: string; email: string | null } {
  const claims = decodeJwtPayload(typeof idToken === 'string' ? idToken : '');
  const audience: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const subject = nonEmpty(claims.sub);
  if (subject === null || claims.iss !== expected.issuer || !audience.includes(expected.clientId) || claims.nonce !== expected.nonce)
    throw new CodexAuthError(`OpenAI sent back an identity that does not match this sign-in; ${AGAIN}`);
  return { subject, email: emailOf(claims) };
}

interface Encoded {
  type: string;
  body: string;
}

export const asForm = (fields: Record<string, string>): Encoded => ({ type: 'application/x-www-form-urlencoded', body: new URLSearchParams(fields).toString() });

export const asJson = (fields: Record<string, string>): Encoded => ({ type: 'application/json', body: JSON.stringify(fields) });

export async function tokenCall(url: string, sent: Encoded, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': sent.type, accept: 'application/json' }, body: sent.body });
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const body = isRecord(parsed) ? parsed : {};
  if (!res.ok) throw new CodexAuthError(`OpenAI refused the token request (${String(res.status)}): ${nonEmpty(body.error_description) ?? nonEmpty(body.error) ?? raw.slice(0, 300)}`);
  return body;
}

export function grantOf(body: Record<string, unknown>, keptRefresh: string, now: number): Omit<CodexCredential, 'email'> {
  const accessToken = nonEmpty(body.access_token) ?? '';
  const refreshToken = nonEmpty(body.refresh_token) ?? keptRefresh;
  if (accessToken === '' || refreshToken === '') throw new CodexAuthError('OpenAI returned no usable tokens; sign in again');
  const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1000 : DEFAULT_TTL_MS;
  return { accessToken, refreshToken, expiresAt: now + ttl, savedAt: new Date(now).toISOString() };
}

const tokensFrom = (body: Record<string, unknown>, who: Pick<ChatgptTokens, 'clientId' | 'subject' | 'email'>, keptRefresh: string, now: number): ChatgptTokens => ({
  method: 'chatgpt',
  clientId: who.clientId,
  subject: who.subject,
  email: who.email,
  ...grantOf(body, keptRefresh, now),
});

const officialToken = (issuer: string): string => `${issuer}/api/accounts/oauth/token`;

function clientOf(started: Pending, returned: string | null): string {
  const clientId = started.clientId ?? returned;
  if (clientId === null || clientId === NEW_CLIENT) throw new CodexAuthError(`ChatGPT did not finish registering Metro; ${AGAIN}`);
  if (returned !== null && returned !== clientId) throw new CodexAuthError(`ChatGPT answered for another Metro registration; ${AGAIN}`);
  return clientId;
}

export async function finishLogin(callback: string, issuer = CODEX_ISSUER, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ChatgptTokens> {
  const { code, state, clientId: returned } = parseCallback(callback);
  const started = pending.take(state, now);
  if (started === undefined) throw new CodexAuthError(`this sign-in link has expired or was started elsewhere; ${AGAIN}`);
  const clientId = clientOf(started, returned);
  const body = await tokenCall(
    officialToken(issuer),
    asForm({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: started.verifier, redirect_uri: CODEX_REDIRECT, resource: OPENAI_API }),
    fetchImpl,
  );
  const who = identityOf(body.id_token, { issuer, clientId, nonce: started.nonce });
  if (started.subject !== null && who.subject !== started.subject)
    throw new CodexAuthError('this is another ChatGPT account than the one this connection signed in with; add a new connection for it');
  const scopes = (nonEmpty(body.scope) ?? '').split(/\s+/);
  if (!scopes.includes(PLAN_SCOPE)) throw new CodexAuthError('ChatGPT did not allow Metro to use your plan: sign in again and allow it (it needs ChatGPT Plus or Pro)');
  return tokensFrom(body, { clientId, ...who }, '', now);
}

export async function refreshTokens(previous: ChatgptTokens, issuer = CODEX_ISSUER, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ChatgptTokens> {
  const body = await tokenCall(
    officialToken(issuer),
    asForm({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, resource: OPENAI_API }),
    fetchImpl,
  );
  return tokensFrom(body, previous, previous.refreshToken, now);
}

export const tokensStale = (tokens: CodexTokens, now = Date.now()): boolean => now >= tokens.expiresAt - RENEW_BEFORE_MS;
