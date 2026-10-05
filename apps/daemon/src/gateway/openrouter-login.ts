import { createHash } from 'node:crypto';
import { pkcePair, newState } from '@metro-labs/core/stations/oauth';
import { ticketStore } from '@metro-labs/core/tickets';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { addConnection, connectionOf, updateConnection } from './model-config.js';
import { asApiError, type Store } from './model-store.js';
import { forgetReported } from './usage.js';

export const OPENROUTER_CALLBACK = '/api/model/openrouter/callback';
const TTL = 10 * 60_000;
const MAX_ATTEMPTS = 100;
const STALE = 'This OpenRouter sign-in expired or was cancelled. Start again.';
const FAILED = 'OpenRouter sign-in did not finish. Try again or use an API key. Manage any unused key in OpenRouter.';

type Result = { status: 'pending' } | { status: 'done'; connection: string } | { status: 'failed'; error: string };

interface Attempt {
  owner: string;
  connection: string;
  keyHash: string;
  expiresAt: number;
  state: string;
  verifier: string;
  result: Result;
  abort: AbortController;
}

interface LoginDeps {
  store: Store;
  owner: () => string | null;
  publicBase: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function callbackUrl(base: string | null): string {
  let url: URL;
  try {
    url = new URL(base ?? '');
  } catch {
    throw new ApiError('This box needs a public HTTPS address for OpenRouter sign-in. Use an API key instead.', 409);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new ApiError('This box needs a public HTTPS origin for OpenRouter sign-in. Use an API key instead.', 409);
  return `${url.origin}${OPENROUTER_CALLBACK}`;
}

async function exchange(code: string, verifier: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(FAILED, 502);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.key !== 'string' || body.key.trim() === '' || body.key.length > 512)
    throw new ApiError(FAILED, 502);
  return body.key.trim();
}

function authorizationCode(params: URLSearchParams): string {
  const code = params.get('code') ?? '';
  if (params.has('error') || code === '' || code.length > 4096 || params.getAll('code').length !== 1 || params.getAll('state').length !== 1)
    throw new ApiError('OpenRouter did not approve this sign-in. Try again or use an API key.', 400);
  return code;
}

export class OpenRouterLogins {
  private readonly states = ticketStore<Attempt>(TTL, MAX_ATTEMPTS);
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly deps: LoginDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private discard(attempt: Attempt): void {
    this.states.take(attempt.state, this.now());
    attempt.verifier = '';
    attempt.abort.abort();
  }

  private prune(): void {
    for (const [id, attempt] of this.attempts) {
      if (attempt.expiresAt > this.now()) continue;
      this.discard(attempt);
      this.attempts.delete(id);
    }
  }

  private checkOwner(owner: string): void {
    if (this.deps.owner() !== owner) throw new ApiError('This sign-in belongs to another organization.', 403);
  }

  private target(connection: string): string {
    const cfg = this.deps.store.read();
    if (connection === '') {
      try {
        addConnection(cfg, { provider: 'openrouter' });
      } catch (err) {
        asApiError(err);
      }
      return '';
    }
    const found = connectionOf(cfg, connection);
    if (found?.provider !== 'openrouter') throw new ApiError('This OpenRouter connection no longer exists.', 404);
    return hash(found.apiKey);
  }

  begin(owner: string, connection: string): { id: string; url: string; expiresAt: number } {
    this.checkOwner(owner);
    const callback = callbackUrl(this.deps.publicBase());
    const keyHash = this.target(connection);
    this.prune();
    if (this.attempts.size >= MAX_ATTEMPTS) throw new ApiError('Too many OpenRouter sign-ins. Try again later.', 429);
    const { verifier, challenge } = pkcePair();
    const attempt: Attempt = { owner, connection, keyHash, verifier, state: '', expiresAt: this.now() + TTL, result: { status: 'pending' }, abort: new AbortController() };
    attempt.state = this.states.mint(attempt, this.now()).ticket;
    const id = newState();
    this.attempts.set(id, attempt);
    const url = new URL('https://openrouter.ai/auth');
    url.search = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', state: attempt.state, key_label: 'Metro' }).toString();
    return { id, url: url.href, expiresAt: attempt.expiresAt };
  }

  private find(owner: string, id: string): Attempt {
    this.checkOwner(owner);
    this.prune();
    const attempt = this.attempts.get(id);
    if (attempt?.owner !== owner) throw new ApiError(STALE, 410);
    return attempt;
  }

  status(owner: string, id: string): Result {
    return this.find(owner, id).result;
  }

  cancel(owner: string, id: string): Result {
    const attempt = this.find(owner, id);
    if (attempt.result.status === 'pending') {
      attempt.result = { status: 'failed', error: 'OpenRouter sign-in cancelled.' };
      this.discard(attempt);
    }
    return attempt.result;
  }

  private checkPending(attempt: Attempt): void {
    if (attempt.expiresAt <= this.now() || attempt.result.status !== 'pending') throw new ApiError(STALE, 410);
    this.checkOwner(attempt.owner);
    if (this.target(attempt.connection) !== attempt.keyHash)
      throw new ApiError('This connection changed during sign-in. Start again.', 409);
  }

  private save(attempt: Attempt, key: string): void {
    this.checkPending(attempt);
    const current = this.deps.store.read();
    const next = attempt.connection === '' ? addConnection(current, { provider: 'openrouter', apiKey: key }) : updateConnection(current, attempt.connection, { apiKey: key });
    const id = attempt.connection === '' ? (next.connections.at(-1)?.id ?? '') : attempt.connection;
    this.deps.store.write(next);
    forgetReported(id);
    attempt.result = { status: 'done', connection: id };
    log.info({ connection: id }, 'model-api: OpenRouter connected');
  }

  async complete(params: URLSearchParams): Promise<void> {
    const state = params.get('state') ?? '';
    const attempt = this.states.take(state, this.now());
    if (attempt === undefined) throw new ApiError(STALE, 410);
    const verifier = attempt.verifier;
    attempt.verifier = '';
    try {
      this.checkPending(attempt);
      const key = await exchange(authorizationCode(params), verifier, attempt.abort.signal, this.deps.fetchImpl ?? fetch);
      this.save(attempt, key);
    } catch (err) {
      if (attempt.result.status === 'pending') attempt.result = { status: 'failed', error: err instanceof ApiError ? err.message : FAILED };
      throw new ApiError(attempt.result.status === 'failed' ? attempt.result.error : FAILED, 400);
    } finally {
      this.discard(attempt);
    }
  }
}
