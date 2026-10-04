import { randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { stringOf } from '@metro-labs/http/api-http';
import { asForm, asJson, CODEX_ISSUER, CodexAuthError, decodeJwtPayload, emailOf, grantOf, tokenCall, type CodeTokens } from './codex-auth.js';
import { nonEmpty } from './text.js';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const VERIFY_PATH = '/codex/device';
const DEVICE_TTL_MS = 15 * 60_000;
const DEFAULT_INTERVAL_S = 5;
const ID_BYTES = 18;
const AGAIN = 'press Sign in with a code again';

export interface DeviceLogin {
  id: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
}

export type DeviceStatus = { status: 'pending' } | { status: 'done'; tokens: CodeTokens } | { status: 'failed'; error: string };

interface Entry {
  deviceAuthId: string;
  userCode: string;
  interval: number;
  issuer: string;
  startedAt: number;
  polledAt: number | null;
}

const logins = new Map<string, Entry>();

function claimsOf(idToken: string): { accountId: string | null; email: string | null; plan: string | null } {
  const payload = decodeJwtPayload(idToken);
  const auth = isRecord(payload[AUTH_CLAIM]) ? payload[AUTH_CLAIM] : {};
  return { accountId: nonEmpty(auth.chatgpt_account_id), email: emailOf(payload), plan: nonEmpty(auth.chatgpt_plan_type) };
}

function codeTokensFrom(body: Record<string, unknown>, previous: CodeTokens | null, now: number): CodeTokens {
  const fresh = claimsOf(nonEmpty(body.id_token) ?? '');
  const kept = previous ?? { accountId: null, email: null, plan: null, refreshToken: '' };
  const accountId = fresh.accountId ?? kept.accountId ?? '';
  if (accountId === '') throw new CodexAuthError('the id token carries no ChatGPT account id; sign in with a ChatGPT account that has Codex');
  return { method: 'code', accountId, email: fresh.email ?? kept.email, plan: fresh.plan ?? kept.plan, ...grantOf(body, kept.refreshToken, now) };
}

const cliToken = (issuer: string): string => `${issuer}/oauth/token`;

export async function refreshCodeTokens(previous: CodeTokens, issuer = CODEX_ISSUER, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<CodeTokens> {
  const body = await tokenCall(cliToken(issuer), asJson({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: previous.refreshToken }), fetchImpl);
  return codeTokensFrom(body, previous, now);
}

function intervalOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_INTERVAL_S;
}

function sweep(now: number): void {
  for (const [id, entry] of logins) if (now - entry.startedAt > DEVICE_TTL_MS) logins.delete(id);
}

const post = (url: string, body: unknown, fetchImpl: typeof fetch): Promise<Response> =>
  fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function beginDeviceLogin(issuer = CODEX_ISSUER, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DeviceLogin> {
  sweep(now);
  const res = await post(`${issuer}/api/accounts/deviceauth/usercode`, { client_id: CODEX_CLIENT_ID }, fetchImpl);
  if (res.status === 404) throw new CodexAuthError('OpenAI is not offering the code sign-in right now; use Continue with ChatGPT instead');
  if (!res.ok) throw new CodexAuthError(`OpenAI refused to start the code sign-in (${String(res.status)})`);
  const body: unknown = await res.json();
  const parsed = isRecord(body) ? body : {};
  const deviceAuthId = stringOf(parsed.device_auth_id);
  const userCode = stringOf(parsed.user_code) || stringOf(parsed.usercode);
  if (deviceAuthId === '' || userCode === '') throw new CodexAuthError('OpenAI answered without a device code');
  const id = randomBytes(ID_BYTES).toString('base64url');
  const interval = intervalOf(parsed.interval);
  logins.set(id, { deviceAuthId, userCode, interval, issuer, startedAt: now, polledAt: null });
  return { id, userCode, verifyUrl: `${issuer}${VERIFY_PATH}`, interval };
}

async function claim(entry: Entry, fetchImpl: typeof fetch, now: number): Promise<DeviceStatus> {
  const res = await post(`${entry.issuer}/api/accounts/deviceauth/token`, { device_auth_id: entry.deviceAuthId, user_code: entry.userCode }, fetchImpl);
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    return { status: 'pending' };
  }
  if (!res.ok) return { status: 'failed', error: `OpenAI ended the code sign-in (${String(res.status)})` };
  const body: unknown = await res.json();
  const parsed = isRecord(body) ? body : {};
  const code = stringOf(parsed.authorization_code);
  const verifier = stringOf(parsed.code_verifier);
  if (code === '' || verifier === '') return { status: 'failed', error: 'OpenAI approved the sign-in but sent no code back' };
  const granted = await tokenCall(
    cliToken(entry.issuer),
    asForm({ grant_type: 'authorization_code', code, redirect_uri: `${entry.issuer}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: verifier }),
    fetchImpl,
  );
  return { status: 'done', tokens: codeTokensFrom(granted, null, now) };
}

export async function pollDeviceLogin(id: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DeviceStatus> {
  sweep(now);
  const entry = logins.get(id);
  if (entry === undefined) throw new CodexAuthError(`this sign-in has expired or already finished; ${AGAIN}`);
  if (entry.polledAt !== null && now - entry.polledAt < entry.interval * 1000) return { status: 'pending' };
  entry.polledAt = now;
  let result: DeviceStatus;
  try {
    result = await claim(entry, fetchImpl, now);
  } catch (err) {
    result = { status: 'failed', error: errMsg(err) };
  }
  if (result.status !== 'pending') logins.delete(id);
  return result;
}
