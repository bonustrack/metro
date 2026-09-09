import { randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { CODEX_CLIENT_ID, CODEX_ISSUER, CodexAuthError, exchangeCode, type CodexTokens } from './codex-auth.js';

const VERIFY_PATH = '/codex/device';
const DEVICE_TTL_MS = 15 * 60_000;
const DEFAULT_INTERVAL_S = 5;
const ID_BYTES = 18;

export interface DeviceLogin {
  id: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
}

export type DeviceStatus = { status: 'pending' } | { status: 'done'; tokens: CodexTokens } | { status: 'failed'; error: string };

interface Entry {
  deviceAuthId: string;
  userCode: string;
  interval: number;
  issuer: string;
  startedAt: number;
  polledAt: number | null;
}

const logins = new Map<string, Entry>();

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

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
  if (res.status === 404) throw new CodexAuthError('OpenAI is not offering the device-code sign-in right now; use the browser sign-in instead');
  if (!res.ok) throw new CodexAuthError(`OpenAI refused to start the device-code sign-in (${String(res.status)})`);
  const body: unknown = await res.json();
  const parsed = isRecord(body) ? body : {};
  const deviceAuthId = str(parsed.device_auth_id);
  const userCode = str(parsed.user_code) || str(parsed.usercode);
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
  if (!res.ok) return { status: 'failed', error: `OpenAI ended the device-code sign-in (${String(res.status)})` };
  const body: unknown = await res.json();
  const parsed = isRecord(body) ? body : {};
  const code = str(parsed.authorization_code);
  const verifier = str(parsed.code_verifier);
  if (code === '' || verifier === '') return { status: 'failed', error: 'OpenAI approved the sign-in but sent no code back' };
  const tokens = await exchangeCode(entry.issuer, code, verifier, `${entry.issuer}/deviceauth/callback`, fetchImpl, now);
  return { status: 'done', tokens };
}

export async function pollDeviceLogin(id: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DeviceStatus> {
  sweep(now);
  const entry = logins.get(id);
  if (entry === undefined) throw new CodexAuthError('this sign-in has expired or already finished; press Connect again');
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
