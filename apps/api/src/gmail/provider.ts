import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike, Tokens } from '@metro-labs/core/stations/oauth';
import type { GmailConfig } from './config.js';
import { GmailError, inputMailbox } from './input.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const REDIRECT_URI = 'https://metro.box/';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const FETCH_MS = 15_000;

const scopes = (sendEnabled: boolean): string[] => sendEnabled ? [READ_SCOPE, SEND_SCOPE] : [READ_SCOPE];

export function gmailAuthorizeUrl(config: GmailConfig, state: string, challenge: string, mailbox: string | null, sendEnabled: boolean): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: scopes(sendEnabled).join(' '),
    ...(sendEnabled ? { include_granted_scopes: 'true' } : {}),
    ...(mailbox === null ? {} : { login_hint: mailbox }),
  }).toString();
  return url.toString();
}

async function googleRequest(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(FETCH_MS) });
  } catch {
    throw new GmailError('Google could not be reached for Gmail sign-in. Try again.', 503);
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) throw new GmailError('Google returned an invalid Gmail sign-in response.', 503);
  return body;
}

async function post(fetchImpl: FetchLike, url: string, fields: Record<string, string>): Promise<Response> {
  return googleRequest(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
}

function assertScopes(value: unknown, sendEnabled: boolean): void {
  const granted = typeof value === 'string' ? value.trim().split(/\s+/) : [];
  const allowed = scopes(sendEnabled);
  if (allowed.some((scope) => !granted.includes(scope)) || granted.some((scope) => !allowed.includes(scope)))
    throw new GmailError('Google did not grant exactly the approved Gmail permissions. Connect Gmail again.', 400);
}

const tokenText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\p{Cc}]/u.test(value);

function tokenFields(body: Record<string, unknown>, now: number, previous?: string): Tokens {
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token === undefined ? previous : body.refresh_token;
  const seconds = body.expires_in;
  if (!tokenText(accessToken) || !tokenText(refreshToken) || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')
    throw new GmailError('Google did not return the Gmail tokens needed. Connect Gmail again.', 503);
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400)
    throw new GmailError('Google returned an invalid Gmail token lifetime.', 503);
  return { accessToken, refreshToken, expiresAt: now + seconds * 1000 };
}

async function gmailTokens(fetchImpl: FetchLike, fields: Record<string, string>, sendEnabled: boolean, now: () => number, previous?: string): Promise<Tokens> {
  const response = await post(fetchImpl, TOKEN_URL, fields);
  if (!response.ok) throw new GmailError('Google refused this Gmail sign-in. Connect Gmail again.', response.status === 400 || response.status === 401 ? 400 : 503);
  const body = await responseBody(response);
  assertScopes(body.scope, sendEnabled);
  return tokenFields(body, now(), previous);
}

export function exchangeGmailCode(fetchImpl: FetchLike, config: GmailConfig, code: string, verifier: string, sendEnabled: boolean, now: () => number): Promise<Tokens> {
  return gmailTokens(fetchImpl, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    code,
  }, sendEnabled, now);
}

export function refreshGmailTokens(fetchImpl: FetchLike, config: GmailConfig, refreshToken: string, sendEnabled: boolean, now: () => number): Promise<Tokens> {
  return gmailTokens(fetchImpl, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, sendEnabled, now, refreshToken);
}

export async function gmailProfile(fetchImpl: FetchLike, accessToken: string): Promise<string> {
  const response = await googleRequest(fetchImpl, PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (!response.ok) throw new GmailError('Google could not verify this Gmail mailbox. Check Gmail access and connect again.', 503);
  const body = await responseBody(response);
  const email = inputMailbox(body.emailAddress);
  if (email === null) throw new GmailError('Google did not identify this Gmail mailbox.', 503);
  return email;
}

export async function revokeGmailToken(fetchImpl: FetchLike, refreshToken: string): Promise<void> {
  const response = await post(fetchImpl, REVOKE_URL, { token: refreshToken });
  if (response.ok) return;
  const body: unknown = response.status === 400 ? await response.json().catch(() => null) : null;
  if (isRecord(body) && body.error === 'invalid_token') return;
  throw new GmailError('Google could not revoke this Gmail sign-in. Try again.', 503);
}
