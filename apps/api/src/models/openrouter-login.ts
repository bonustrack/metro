import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { pkcePair } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { modelDetailOf, modelDetailText, sealModelSecret } from '@metro-labs/connectors/model-secret';
import { isoNow, modelKey, type Caller, type ModelsDeps, type OpenRouterPending } from './deps.js';
import { connectionArg, labelFor, newModelRow } from './input.js';
import { roomFor } from './manage.js';
import { returnToOf as pageReturnTo } from '../connectors/sign-in.js';

export const OPENROUTER_CALLBACK = 'https://api.metro.box/api/models/openrouter/callback';
const DEFAULT_RETURN = 'https://metro.box/';
const OPENROUTER_AUTH = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS = 'https://openrouter.ai/api/v1/auth/keys';
const KEY_MAX = 512;
const STALE = 'This OpenRouter sign-in expired or was already used. Start again.';
const FAILED = 'OpenRouter sign-in did not finish. Try again or use an API key. Manage any unused key in OpenRouter.';
const CHANGED = 'This connection changed during sign-in. Start again.';

const returnToOf = (raw: unknown): string => (raw === undefined || raw === null || raw === '' ? DEFAULT_RETURN : pageReturnTo(raw));

async function revisionOf(deps: ModelsDeps, owner: string, connection: string | null): Promise<number | null> {
  if (connection === null) return null;
  const row = await deps.store.find(owner, connection);
  if (row?.provider !== 'openrouter') throw new ApiError('no such OpenRouter connection', 404);
  return row.revision;
}

export async function beginOpenRouter(deps: ModelsDeps, caller: Caller, body: unknown): Promise<{ authorizeUrl: string }> {
  modelKey(deps);
  const connection = connectionArg(body);
  const returnTo = returnToOf(isRecord(body) ? body.returnTo : undefined);
  const revision = await revisionOf(deps, caller.owner, connection);
  const { verifier, challenge } = pkcePair();
  const pending: OpenRouterPending = { owner: caller.owner, userId: caller.session.userId, connection, revision, verifier, returnTo };
  const { ticket } = deps.openrouterLogins.mint(pending, deps.now());
  const url = new URL(OPENROUTER_AUTH);
  url.search = new URLSearchParams({ callback_url: deps.openrouterCallback, code_challenge: challenge, code_challenge_method: 'S256', state: ticket, key_label: 'Metro' }).toString();
  return { authorizeUrl: url.href };
}

function authorizationCode(params: URLSearchParams): string {
  const code = params.get('code') ?? '';
  if (params.has('error') || code === '' || code.length > 4096 || params.getAll('code').length !== 1) throw new ApiError('OpenRouter did not approve this sign-in. Try again or use an API key.', 400);
  return code;
}

async function exchange(deps: ModelsDeps, code: string, verifier: string): Promise<string> {
  const res = await deps.fetch(OPENROUTER_KEYS, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(FAILED, 400);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || typeof body.key !== 'string' || body.key.trim() === '' || body.key.length > KEY_MAX) throw new ApiError(FAILED, 400);
  return body.key.trim();
}

async function save(deps: ModelsDeps, entry: OpenRouterPending, apiKey: string): Promise<string> {
  const key = modelKey(deps);
  if (entry.connection === null) {
    const taken = await roomFor(deps, entry.owner);
    const row = newModelRow(entry, 'openrouter', labelFor(taken, 'openrouter', ''), isoNow(deps));
    await deps.store.create({ ...row, secret: sealModelSecret(key, row, { kind: 'key', apiKey }) });
    return row.id;
  }
  const saved = await deps.store.edit(entry.owner, entry.connection, isoNow(deps), (row: ModelConnectionRow) => {
    if (row.provider !== 'openrouter' || row.revision !== entry.revision) throw new ApiError(CHANGED, 409);
    const detail = modelDetailOf(row.detail);
    delete detail.signedOut;
    return { change: { secret: sealModelSecret(key, row, { kind: 'key', apiKey }), detail: modelDetailText(detail) }, credential: true };
  });
  return saved.id;
}

function pageAddress(returnTo: string, owner: string | null, params: Record<string, string>): string {
  const url = new URL(returnTo);
  url.search = '';
  url.hash = `#/${owner === null ? '' : `${owner}/`}organization/models?${new URLSearchParams(params).toString()}`;
  return url.toString();
}

export async function openRouterCallback(deps: ModelsDeps, params: URLSearchParams): Promise<string> {
  const entry = deps.openrouterLogins.take(params.get('state') ?? '', deps.now());
  if (entry === undefined) return pageAddress(DEFAULT_RETURN, null, { openrouter_error: STALE });
  try {
    const apiKey = await exchange(deps, authorizationCode(params), entry.verifier);
    const id = await save(deps, entry, apiKey);
    log.info({ owner: entry.owner, id }, 'models: OpenRouter connected');
    return pageAddress(entry.returnTo, entry.owner, { openrouter: id });
  } catch (err) {
    log.warn({ owner: entry.owner, err: errMsg(err) }, 'models: an OpenRouter sign-in did not finish');
    return pageAddress(entry.returnTo, entry.owner, { openrouter_error: err instanceof ApiError ? err.message : FAILED });
  }
}
