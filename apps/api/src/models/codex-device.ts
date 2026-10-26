import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';
import { asForm, CODEX_CLI_CLIENT, CODEX_ISSUER, codeClaimsOf, tokenCall } from '@metro-labs/connectors/codex-tokens';
import type { CodexSecret, ModelDetail } from '@metro-labs/connectors/model-secret';
import { modelKey, type Caller, type DevicePending, type ModelsDeps } from './deps.js';
import { codexRow, saveCodex } from './codex-save.js';
import { grantFrom } from './codex-login.js';
import { connectionArg } from './input.js';
import type { ConnectionView } from './view.js';

const VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
const DEFAULT_INTERVAL_S = 5;
const CALL_TIMEOUT_MS = 15_000;
const AGAIN = 'press Sign in with a code again';

interface DeviceStart {
  id: string;
  user_code: string;
  verify_url: string;
  interval: number;
}

type Claimed = { status: 'pending' } | { status: 'failed'; error: string } | { status: 'done'; secret: CodexSecret; detail: ModelDetail };

type DeviceAnswer = { status: 'pending' } | { status: 'failed'; error: string } | { status: 'done'; connection: ConnectionView };

const post = (deps: ModelsDeps, url: string, body: unknown): Promise<Response> =>
  deps.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });

function intervalOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_INTERVAL_S;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null);
  return isRecord(body) ? body : {};
}

export async function beginDevice(deps: ModelsDeps, caller: Caller, body: unknown): Promise<DeviceStart> {
  modelKey(deps);
  const connection = connectionArg(body);
  if (connection !== null) await codexRow(deps, caller.owner, connection);
  const res = await post(deps, `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, { client_id: CODEX_CLI_CLIENT });
  if (res.status === 404) throw new ApiError('OpenAI is not offering the code sign-in right now; use Continue with ChatGPT instead', 400);
  if (!res.ok) throw new ApiError(`OpenAI refused to start the code sign-in (${String(res.status)})`, 503);
  const parsed = await jsonOf(res);
  const deviceAuthId = stringOf(parsed.device_auth_id);
  const userCode = stringOf(parsed.user_code) || stringOf(parsed.usercode);
  if (deviceAuthId === '' || userCode === '') throw new ApiError('OpenAI answered without a device code', 503);
  const interval = intervalOf(parsed.interval);
  const pending: DevicePending = { owner: caller.owner, userId: caller.session.userId, connection, deviceAuthId, userCode, interval, polledAt: null };
  const { ticket } = deps.devices.mint(pending, deps.now());
  return { id: ticket, user_code: userCode, verify_url: VERIFY_URL, interval };
}

async function claim(deps: ModelsDeps, entry: DevicePending): Promise<Claimed> {
  const res = await post(deps, `${CODEX_ISSUER}/api/accounts/deviceauth/token`, { device_auth_id: entry.deviceAuthId, user_code: entry.userCode });
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    return { status: 'pending' };
  }
  if (!res.ok) return { status: 'failed', error: `OpenAI ended the code sign-in (${String(res.status)})` };
  const parsed = await jsonOf(res);
  const code = stringOf(parsed.authorization_code);
  const verifier = stringOf(parsed.code_verifier);
  if (code === '' || verifier === '') return { status: 'failed', error: 'OpenAI approved the sign-in but sent no code back' };
  const fields = { grant_type: 'authorization_code', code, redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`, client_id: CODEX_CLI_CLIENT, code_verifier: verifier };
  const granted = await tokenCall(`${CODEX_ISSUER}/oauth/token`, asForm(fields), deps.fetch);
  const claims = codeClaimsOf(granted.id_token);
  if (claims.accountId === null) return { status: 'failed', error: 'the id token carries no ChatGPT account id; sign in with a ChatGPT account that has Codex' };
  const secret: CodexSecret = { kind: 'codex', method: 'code', ...grantFrom(granted, deps.now()), accountId: claims.accountId };
  const detail: ModelDetail = { method: 'code', accountId: claims.accountId, ...(claims.email === null ? {} : { email: claims.email }), ...(claims.plan === null ? {} : { plan: claims.plan }) };
  return { status: 'done', secret, detail };
}

function entryFor(deps: ModelsDeps, caller: Caller, id: string): DevicePending {
  const entry = deps.devices.peek(id, deps.now());
  if (entry?.owner !== caller.owner || entry.userId !== caller.session.userId) throw new ApiError(`this sign-in has expired or already finished; ${AGAIN}`, 404);
  return entry;
}

export async function pollDevice(deps: ModelsDeps, caller: Caller, id: string): Promise<DeviceAnswer> {
  const entry = entryFor(deps, caller, id);
  const now = deps.now();
  if (entry.polledAt !== null && now - entry.polledAt < entry.interval * 1000) return { status: 'pending' };
  entry.polledAt = now;
  let result: Claimed;
  try {
    result = await claim(deps, entry);
  } catch (err) {
    result = { status: 'failed', error: errMsg(err) };
  }
  if (result.status === 'pending') return result;
  deps.devices.take(id, deps.now());
  if (result.status === 'failed') return result;
  return { status: 'done', ...(await saveCodex(deps, caller, entry.connection, result.secret, result.detail)) };
}
