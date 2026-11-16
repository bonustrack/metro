import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { log, errMsg } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { isAppReturn, validateReturnTo } from '@metro-labs/http/return-to';
import { bearerSession, type Session } from '@metro-labs/http/workos-token';
import { linkIdentity } from '../db/identities.js';
import { invitationFrom, startEmailCode, verifyEmailCode } from './email.js';
import type { UserLogin } from '../users.js';
import { admit, type Arrival, type Intent, type Refusal } from './operator.js';
import { createOrg, logout, mePayload, organizationsOf, refresh, switchOrg, tokensPayload, updateAccount, type AuthApiDeps } from './account-routes.js';
import { redeemLink } from './login-links.js';
import { landingOrganization, modeOf, startSession, userLoginOf, type Placement } from './metro-tokens.js';
import { clientAddress } from './rate-limit.js';
import { authorizeUrl, newAttempt, providerOf, providerProof, type Attempt } from './oauth.js';
import { isProviderId, SignInRefused, type Proof } from './providers.js';
import { acceptInvitationsFor, authorizationUrl, configOf, exchangeCode, isProvider, refreshTokens, WorkosError, type Tokens, type WorkosConfig } from './workos.js';

export type { AuthApiDeps } from './account-routes.js';

const PREFIX = '/api/auth';
const STATE_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 60_000;
const STATES_MAX = 5000;
const STATES_PER_ADDRESS = 10;
const HANDOFFS_MAX = 1000;

interface Pending<T> {
  value: T;
  at: number;
}

interface Started {
  address: string;
  returnTo: string;
  intent: Intent;
  invitation?: string;
  challenge?: string;
  attempt?: Attempt;
}

interface Handoff {
  tokens: Tokens;
  challenge?: string;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

const states = new Map<string, Pending<Started>>();
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

function signInChallenge(deps: AuthApiDeps, returnTo: string, challenge: string): { challenge?: string } {
  const app = isAppReturn(returnTo);
  if (!app && !validateReturnTo(returnTo)) throw new ApiError('return_to must be a metro page', 400);
  if (challenge === '' && !app && modeOf(deps) === 'workos') return {};
  if (!CHALLENGE_RE.test(challenge)) throw new ApiError('a sign-in needs a code_challenge (S256)', 400);
  return { challenge };
}

function keepState(state: string, started: Started, now: number): void {
  prune(states, STATE_TTL_MS, now, STATES_MAX);
  const mine = [...states].filter(([, entry]) => entry.value.address === started.address);
  for (const [key] of mine.slice(0, Math.max(0, mine.length - STATES_PER_ADDRESS + 1))) states.delete(key);
  states.set(state, { value: started, at: now });
}

function providerUrl(req: IncomingMessage, deps: AuthApiDeps, provider: string | null, state: string): { url: string; attempt?: Attempt } {
  if (modeOf(deps) === 'workos') {
    if (!isProvider(provider)) throw new ApiError('provider must be google, microsoft or github', 400);
    return { url: authorizationUrl(configOf(deps), provider, callbackUri(req, deps), state) };
  }
  if (!isProviderId(provider)) throw new ApiError('provider must be google or microsoft', 400);
  const attempt = newAttempt(provider);
  return { url: authorizeUrl(providerOf(deps.providers, provider), callbackUri(req, deps), state, attempt), attempt };
}

function login(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, query: URLSearchParams): void {
  const returnTo = query.get('return_to') ?? '';
  const state = token();
  const { url, attempt } = providerUrl(req, deps, query.get('provider'), state);
  const proof = signInChallenge(deps, returnTo, query.get('code_challenge') ?? '');
  const invitation = modeOf(deps) === 'workos' ? invitationFrom(query.get('invitation_token') ?? '') : {};
  const intent = query.get('intent') === 'waitlist' ? 'waitlist' : 'login';
  keepState(state, { address: clientAddress(req), returnTo, intent, ...invitation, ...proof, ...(attempt === undefined ? {} : { attempt }) }, (deps.now ?? Date.now)());
  redirect(res, url);
}

const refusedHash = (reason: Refusal): string => `#/login?refused=${reason}`;

const PAGE = 'https://metro.box/';
const INVITED_HASH = '#/login?invited=1';

function refusal(query: URLSearchParams): Refusal | null {
  const error = query.get('error');
  if (error === null && query.get('code') !== null) return null;
  log.info({ error, description: query.get('error_description') }, 'auth: the provider did not sign the user in');
  return error === 'access_denied' || error === null ? 'cancelled' : 'failed';
}

function handoffFor(tokens: Tokens, now: number, challenge?: string): string {
  prune(handoffs, HANDOFF_TTL_MS, now, HANDOFFS_MAX);
  const handoff = token();
  handoffs.set(handoff, { value: { tokens, ...(challenge === undefined ? {} : { challenge }) }, at: now });
  log.info({ user: tokens.user.id, organization: tokens.organization }, 'auth: signed in');
  return handoff;
}

export async function admitted(deps: AuthApiDeps, arrival: Arrival, intent: Intent, now: number, issue: () => Promise<Tokens>, challenge?: string): Promise<string> {
  const verdict = await admit(deps.users, arrival, intent, new Date(now).toISOString(), modeOf(deps));
  if (verdict.kind === 'in') return `#/auth/${handoffFor(await issue(), now, challenge)}`;
  log.info({ user: arrival.user.id, intent, verdict: verdict.kind }, 'auth: not let in');
  if (verdict.kind === 'waiting') return '#/waitlist?joined=1';
  return refusedHash(verdict.reason);
}

async function withInvitations(cfg: WorkosConfig, tokens: Tokens): Promise<Tokens> {
  const email = tokens.user.email;
  if (tokens.organization !== null || email === null) return tokens;
  const joined = await acceptInvitationsFor(cfg, email).catch((err: unknown) => {
    log.warn({ err: errMsg(err), user: tokens.user.id }, 'auth: the pending invitations could not be accepted');
    return null;
  });
  if (joined === null) return tokens;
  log.info({ user: tokens.user.id, organization: joined }, 'auth: a pending invitation was accepted at sign-in');
  return refreshTokens(cfg, tokens.refreshToken, joined);
}

async function workosAdmitted(deps: AuthApiDeps, signedIn: Tokens, intent: Intent, now: number, challenge?: string): Promise<string> {
  const tokens = await withInvitations(configOf(deps), signedIn);
  return admitted(deps, tokens, intent, now, () => Promise.resolve(tokens), challenge);
}

function arrivalOf(user: UserLogin, proof: Proof): UserLogin {
  return { ...user, email: user.email ?? (proof.emailProven ? proof.email : null), name: user.name ?? proof.name, picture: proof.picture ?? user.picture };
}

interface MetroArrival {
  user: string;
  method: 'google' | 'microsoft' | 'link';
  intent: Intent;
  now: number;
  proof?: Proof;
  challenge?: string;
  link?: string;
}

export async function metroAdmitted(deps: AuthApiDeps, arrival: MetroArrival): Promise<string> {
  const record = await userLoginOf(deps.users, arrival.user);
  if (record === null) throw new SignInRefused('failed', 'the user row is missing');
  const user = arrival.proof === undefined ? record : arrivalOf(record, arrival.proof);
  const place: Placement | null = await landingOrganization(deps, arrival.user);
  return admitted(deps, { user, organization: place?.id ?? null }, arrival.intent, arrival.now, () => startSession(deps, user, arrival.method, place, arrival.link), arrival.challenge);
}

function linkRefusal(err: unknown): never {
  if (err instanceof ApiError && err.status === 403) throw new SignInRefused('unverified', err.message);
  if (err instanceof ApiError && err.status === 409) throw new SignInRefused('other-account', err.message);
  throw err;
}

async function metroLanding(req: IncomingMessage, deps: AuthApiDeps, started: Started, attempt: Attempt, code: string, now: number): Promise<string> {
  const provider = providerOf(deps.providers, attempt.provider);
  const proof = await providerProof(provider, code, callbackUri(req, deps), attempt, now);
  if (deps.db === undefined) throw new ApiError('Metro accounts are not set up on this server', 503);
  const linked = await linkIdentity(deps.db(), { provider: attempt.provider, subject: proof.subject, email: proof.email, emailProven: proof.emailProven, now }).catch(linkRefusal);
  log.info({ user: linked.user, provider: attempt.provider, kind: linked.kind }, 'auth: identity checked');
  return metroAdmitted(deps, { user: linked.user, method: attempt.provider, intent: started.intent, now, proof, ...(started.challenge === undefined ? {} : { challenge: started.challenge }) });
}

async function landing(req: IncomingMessage, deps: AuthApiDeps, started: Started, code: string, now: number): Promise<string> {
  if (started.attempt !== undefined) return metroLanding(req, deps, started, started.attempt, code, now);
  return workosAdmitted(deps, await exchangeCode(configOf(deps), code, started.invitation), started.intent, now, started.challenge);
}

function exchangeRefusal(err: unknown): Refusal {
  if (err instanceof SignInRefused) return err.reason;
  return err instanceof WorkosError && err.code === 'email_verification_required' ? 'unverified' : 'failed';
}

async function callback(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, query: URLSearchParams): Promise<void> {
  if (modeOf(deps) === 'workos') configOf(deps);
  const now = (deps.now ?? Date.now)();
  const started = take(states, query.get('state') ?? '', STATE_TTL_MS, now);
  if (started === null && query.get('code') !== null) {
    log.info('auth: a sign-in started outside metro.box (an invitation), sent to the login page');
    redirect(res, withHash(PAGE, INVITED_HASH));
    return;
  }
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
  if (handoff === null || (handoff.challenge !== undefined && challengeOf(verifier) !== handoff.challenge)) throw new ApiError('that sign-in has already been used or has expired', 404);
  return tokensPayload(handoff.tokens, deps);
}

const workosOnly = <T>(run: (req: IncomingMessage, deps: AuthApiDeps) => Promise<T>) => (req: IncomingMessage, deps: AuthApiDeps): Promise<T> => {
  if (modeOf(deps) === 'metro') throw new ApiError('not found', 404);
  return run(req, deps);
};

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
  '/email/start': { method: 'POST', run: workosOnly(startEmailCode) },
  '/email/verify': { method: 'POST', run: workosOnly((req, deps) => verifyEmailCode(req, deps, workosAdmitted)) },
  '/link': { method: 'POST', run: (req, deps) => redeemLink(req, deps, (user, link, now) => metroAdmitted(deps, { user, method: 'link', intent: 'login', now, link })) },
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
