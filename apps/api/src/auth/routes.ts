import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { log, errMsg } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { isAppReturn, validateReturnTo } from '@metro-labs/http/return-to';
import { bearerSession, type Session } from '@metro-labs/http/user-token';
import { linkIdentity } from '../db/identities.js';
import type { UserLogin } from '../users.js';
import { admit, type Arrival, type Intent, type Refusal } from './operator.js';
import { createOrg, logout, mePayload, organizationsOf, refresh, switchOrg, tokensPayload, updateAccount, type AuthApiDeps } from './account-routes.js';
import { landingOrganization, startSession, userLoginOf, type Placement, type Tokens } from './metro-tokens.js';
import { openState, sealState, stateKeyOr } from './state-seal.js';
import { authorizeUrl, newAttempt, providerOf, providerProof, type Attempt } from './oauth.js';
import { isProviderId, SignInRefused, type Proof, type ProviderId } from './providers.js';

export type { AuthApiDeps } from './account-routes.js';

const PREFIX = '/api/auth';
const HANDOFF_TTL_MS = 60_000;
const HANDOFFS_MAX = 1000;

interface Pending<T> {
  value: T;
  at: number;
}

interface Started {
  returnTo: string;
  intent: Intent;
  challenge: string;
  attempt: Attempt;
}

interface Handoff {
  tokens: Tokens;
  challenge: string;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

const handoffs = new Map<string, Pending<Handoff>>();

const token = (): string => randomBytes(32).toString('base64url');

function prune<T>(map: Map<string, Pending<T>>, ttl: number, now: number, max: number): void {
  for (const [key, entry] of map) if (now - entry.at > ttl) map.delete(key);
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function take<T>(map: Map<string, Pending<T>>, key: string, ttl: number, now: number): T | null {
  const entry = map.get(key);
  map.delete(key);
  return entry === undefined || now - entry.at > ttl ? null : entry.value;
}

function defaultPublicBase(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1:8420';
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' && forwarded !== '' ? forwarded.split(',')[0]?.trim() : /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https';
  return `${proto ?? 'https'}://${host}`;
}

const redirect = (res: ServerResponse, to: string): void => {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' }).end();
};

const withHash = (returnTo: string, hash: string): string => {
  const url = new URL(returnTo);
  url.hash = hash;
  return url.toString();
};

const callbackUri = (req: IncomingMessage, deps: AuthApiDeps): string => `${(deps.publicBase ?? defaultPublicBase)(req)}${PREFIX}/callback`;

function signInChallenge(returnTo: string, challenge: string): string {
  if (!isAppReturn(returnTo) && !validateReturnTo(returnTo)) throw new ApiError('return_to must be a metro page', 400);
  if (!CHALLENGE_RE.test(challenge)) throw new ApiError('a sign-in needs a code_challenge (S256)', 400);
  return challenge;
}

const stateKey = (deps: AuthApiDeps): Buffer => stateKeyOr(deps.stateKey);

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function sealedStart(started: Started): Record<string, unknown> {
  const { attempt } = started;
  return { r: started.returnTo, i: started.intent, c: started.challenge, p: attempt.provider, n: attempt.nonce, k: attempt.verifier };
}

function startedOf(value: Record<string, unknown> | null): Started | null {
  if (value === null) return null;
  const returnTo = text(value.r);
  const challenge = text(value.c);
  const nonce = text(value.n);
  const verifier = text(value.k);
  if (returnTo === undefined || challenge === undefined || !isProviderId(value.p) || nonce === undefined || verifier === undefined) return null;
  return { returnTo, intent: value.i === 'waitlist' ? 'waitlist' : 'login', challenge, attempt: { provider: value.p, nonce, verifier } };
}

function login(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, query: URLSearchParams): void {
  const returnTo = query.get('return_to') ?? '';
  const challenge = signInChallenge(returnTo, query.get('code_challenge') ?? '');
  const provider = query.get('provider');
  if (!isProviderId(provider)) throw new ApiError('provider must be google or microsoft', 400);
  const settings = providerOf(deps.providers, provider);
  const attempt = newAttempt(provider);
  const state = sealState(stateKey(deps), sealedStart({ returnTo, intent: query.get('intent') === 'waitlist' ? 'waitlist' : 'login', challenge, attempt }), (deps.now ?? Date.now)());
  redirect(res, authorizeUrl(settings, callbackUri(req, deps), state, attempt));
}

const refusedHash = (reason: Refusal): string => `#/login?refused=${reason}`;

function refusal(query: URLSearchParams): Refusal | null {
  const error = query.get('error');
  if (error === null && query.get('code') !== null) return null;
  log.info({ error, description: query.get('error_description') }, 'auth: the provider did not sign the user in');
  return error === 'access_denied' || error === null ? 'cancelled' : 'failed';
}

function handoffFor(tokens: Tokens, now: number, challenge: string): string {
  prune(handoffs, HANDOFF_TTL_MS, now, HANDOFFS_MAX);
  const handoff = token();
  handoffs.set(handoff, { value: { tokens, challenge }, at: now });
  log.info({ user: tokens.user.id, organization: tokens.organization }, 'auth: signed in');
  return handoff;
}

async function admitted(deps: AuthApiDeps, arrival: Arrival, intent: Intent, now: number, issue: () => Promise<Tokens>, challenge: string): Promise<string> {
  const verdict = await admit(deps.users, arrival, intent, new Date(now).toISOString());
  if (verdict.kind === 'in') return `#/auth/${handoffFor(await issue(), now, challenge)}`;
  log.info({ user: arrival.user.id, intent, verdict: verdict.kind }, 'auth: not let in');
  if (verdict.kind === 'waiting') return '#/waitlist?joined=1';
  return refusedHash(verdict.reason);
}

function arrivalOf(user: UserLogin, proof: Proof): UserLogin {
  return { ...user, email: user.email ?? (proof.emailProven ? proof.email : null), name: user.name ?? proof.name, picture: proof.picture ?? user.picture };
}

interface MetroArrival {
  user: string;
  method: ProviderId;
  intent: Intent;
  now: number;
  proof: Proof;
  challenge: string;
}

async function metroAdmitted(deps: AuthApiDeps, arrival: MetroArrival): Promise<string> {
  const record = await userLoginOf(deps.users, arrival.user);
  if (record === null) throw new SignInRefused('failed', 'the user row is missing');
  const user = arrivalOf(record, arrival.proof);
  const place: Placement | null = await landingOrganization(deps, arrival.user);
  return admitted(deps, { user, organization: place?.id ?? null }, arrival.intent, arrival.now, () => startSession(deps, user, arrival.method, place), arrival.challenge);
}

function linkRefusal(err: unknown): never {
  if (err instanceof ApiError && err.status === 403) throw new SignInRefused('unverified', err.message);
  if (err instanceof ApiError && err.status === 409) throw new SignInRefused('other-account', err.message);
  throw err;
}

async function landing(req: IncomingMessage, deps: AuthApiDeps, started: Started, code: string, now: number): Promise<string> {
  const { attempt } = started;
  const provider = providerOf(deps.providers, attempt.provider);
  const proof = await providerProof(provider, code, callbackUri(req, deps), attempt, now);
  if (deps.db === undefined) throw new ApiError('Metro accounts are not set up on this server', 503);
  const linked = await linkIdentity(deps.db(), { provider: attempt.provider, subject: proof.subject, email: proof.email, emailProven: proof.emailProven, now }).catch(linkRefusal);
  log.info({ user: linked.user, provider: attempt.provider, kind: linked.kind }, 'auth: identity checked');
  return metroAdmitted(deps, { user: linked.user, method: attempt.provider, intent: started.intent, now, proof, challenge: started.challenge });
}

const exchangeRefusal = (err: unknown): Refusal => (err instanceof SignInRefused ? err.reason : 'failed');

async function callback(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, query: URLSearchParams): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const started = startedOf(openState(stateKey(deps), query.get('state') ?? '', now));
  if (started === null) throw new ApiError('this sign-in link is stale, start again', 400);
  const returnTo = started.returnTo;
  const refused = refusal(query);
  if (refused !== null) {
    redirect(res, withHash(returnTo, refusedHash(refused)));
    return;
  }
  try {
    redirect(res, withHash(returnTo, await landing(req, deps, started, query.get('code') ?? '', now)));
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'auth: the sign-in failed');
    redirect(res, withHash(returnTo, refusedHash(exchangeRefusal(err))));
  }
}

async function exchange(req: IncomingMessage, deps: AuthApiDeps): Promise<unknown> {
  const body = await readJsonBody(req);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  const verifier = isRecord(body) && typeof body.verifier === 'string' ? body.verifier : '';
  const handoff = take(handoffs, code, HANDOFF_TTL_MS, (deps.now ?? Date.now)());
  if (handoff === null || challengeOf(verifier) !== handoff.challenge) throw new ApiError('that sign-in has already been used or has expired', 404);
  return tokensPayload(handoff.tokens, deps);
}

interface PublicRoute {
  method: string;
  run: (req: IncomingMessage, deps: AuthApiDeps) => Promise<unknown>;
}

interface PrivateRoute {
  method: string;
  run: (req: IncomingMessage, deps: AuthApiDeps, session: Session) => Promise<unknown>;
}

const PUBLIC: Record<string, PublicRoute> = {
  '/exchange': { method: 'POST', run: exchange },
  '/refresh': { method: 'POST', run: refresh },
};

const PRIVATE: Record<string, PrivateRoute> = {
  '/me': { method: 'GET', run: (_req, deps, session) => mePayload(session, deps) },
  '/logout': { method: 'POST', run: (_req, deps, session) => logout(session, deps) },
  '/organization': { method: 'POST', run: (req, deps, session) => createOrg(req, session, deps) },
  '/organizations': { method: 'GET', run: (_req, deps, session) => organizationsOf(deps, session) },
  '/switch': { method: 'POST', run: (req, deps, session) => switchOrg(req, session, deps) },
  '/account': { method: 'PUT', run: (req, deps, session) => updateAccount(req, session, deps) },
};

async function navigation(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, path: string, query: URLSearchParams): Promise<boolean> {
  if (path !== '/login' && path !== '/callback') return false;
  if ((req.method ?? 'GET') !== 'GET') throw new ApiError('method not allowed', 405);
  if (path === '/login') login(req, res, deps, query);
  else await callback(req, res, deps, query);
  return true;
}

async function answer(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, path: string, query: URLSearchParams): Promise<void> {
  if (await navigation(req, res, deps, path, query)) return;
  const open = PUBLIC[path];
  const closed = PRIVATE[path];
  const route = open ?? closed;
  if (route === undefined) throw new ApiError('not found', 404);
  if ((req.method ?? 'GET') !== route.method) throw new ApiError('method not allowed', 405);
  if (open !== undefined) {
    sendJson(req, res, 200, await open.run(req, deps));
    return;
  }
  const session = await bearerSession(req, deps.keys);
  if (session === null || closed === undefined) throw new ApiError('unauthorized', 401);
  sendJson(req, res, 200, await closed.run(req, deps, session));
}

export function handleAuthApiRequest(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps): boolean {
  const full = req.url ?? '';
  if (full !== PREFIX && !full.startsWith(`${PREFIX}/`) && !full.startsWith(`${PREFIX}?`)) return false;
  const [rawPath, rawQuery] = full.split('?', 2);
  const path = (rawPath ?? '').slice(PREFIX.length).replace(/\/$/, '');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  answer(req, res, deps, path, new URLSearchParams(rawQuery ?? '')).catch((err: unknown) => {
    apiFailure(req, res, err, 'auth-api');
  });
  return true;
}
