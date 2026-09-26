import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { log, errMsg } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { validateReturnTo } from '@metro-labs/http/return-to';
import type { SlugStore } from '../slug.js';
import type { ServerEntry } from '../server-types.js';
import { parseAccountName, type UserStore } from '../users.js';
import { AVATAR_BODY_MAX, parseAvatar } from '../avatar.js';
import { invitationFrom, startEmailCode, verifyEmailCode } from './email.js';
import { admit, stillIn, type Intent, type Refusal, mayCreateOrganization } from './operator.js';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import {
  acceptInvitationsFor,
  addMembership,
  authorizationUrl,
  createOrganization,
  exchangeCode,
  isProvider,
  ORGANIZATION_NAME_RE,
  organizationName,
  refreshTokens,
  revokeSession,
  updateUserName,
  userOrganizations,
  WorkosError,
  type Tokens,
  type WorkosConfig,
} from './workos.js';

const PREFIX = '/api/auth';
const STATE_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 60_000;
const PENDING_MAX = 200;

export interface AuthApiDeps {
  config: () => WorkosConfig | null;
  keys: SigningKeys;
  slugs: SlugStore;
  users: UserStore;
  agentsOf?: (organization: string) => Promise<ServerEntry[]>;
  publicBase?: (req: IncomingMessage) => string;
  now?: () => number;
}

interface Pending<T> {
  value: T;
  at: number;
}

interface Started {
  returnTo: string;
  intent: Intent;
  invitation?: string;
}

function invitationOf(query: URLSearchParams): { invitation?: string } {
  return invitationFrom(query.get('invitation_token') ?? '');
}

const states = new Map<string, Pending<Started>>();
const handoffs = new Map<string, Pending<Tokens>>();

const token = (): string => randomBytes(32).toString('base64url');

function prune<T>(map: Map<string, Pending<T>>, ttl: number, now: number): void {
  for (const [key, entry] of map) if (now - entry.at > ttl) map.delete(key);
  while (map.size > PENDING_MAX) {
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

function login(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, query: URLSearchParams): void {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  const provider = query.get('provider');
  const returnTo = query.get('return_to') ?? '';
  if (!isProvider(provider)) throw new ApiError('provider must be google, microsoft or github', 400);
  if (!validateReturnTo(returnTo)) throw new ApiError('return_to must be a metro page', 400);
  const now = (deps.now ?? Date.now)();
  prune(states, STATE_TTL_MS, now);
  const state = token();
  states.set(state, { value: { returnTo, intent: query.get('intent') === 'waitlist' ? 'waitlist' : 'login', ...invitationOf(query) }, at: now });
  redirect(res, authorizationUrl(cfg, provider, callbackUri(req, deps), state));
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

function handoffFor(tokens: Tokens, now: number): string {
  prune(handoffs, HANDOFF_TTL_MS, now);
  const handoff = token();
  handoffs.set(handoff, { value: tokens, at: now });
  log.info({ user: tokens.user.id, organization: tokens.organization }, 'auth: signed in');
  return handoff;
}

async function withInvitations(deps: AuthApiDeps, tokens: Tokens): Promise<Tokens> {
  const cfg = deps.config();
  const email = tokens.user.email;
  if (cfg === null || tokens.organization !== null || email === null) return tokens;
  const joined = await acceptInvitationsFor(cfg, email).catch((err: unknown) => {
    log.warn({ err: errMsg(err), user: tokens.user.id }, 'auth: the pending invitations could not be accepted');
    return null;
  });
  if (joined === null) return tokens;
  log.info({ user: tokens.user.id, organization: joined }, 'auth: a pending invitation was accepted at sign-in');
  return refreshTokens(cfg, tokens.refreshToken, joined);
}

async function admitted(deps: AuthApiDeps, signedIn: Tokens, intent: Intent, now: number): Promise<string> {
  const tokens = await withInvitations(deps, signedIn);
  const verdict = await admit(deps.users, tokens, intent, new Date(now).toISOString());
  if (verdict.kind === 'in') return `#/auth/${handoffFor(tokens, now)}`;
  log.info({ user: tokens.user.id, intent, verdict: verdict.kind }, 'auth: not let in');
  if (verdict.kind === 'waiting') return '#/waitlist?joined=1';
  return refusedHash(verdict.reason);
}

async function landing(cfg: WorkosConfig, deps: AuthApiDeps, started: Started, code: string, now: number): Promise<string> {
  return admitted(deps, await exchangeCode(cfg, code, started.invitation), started.intent, now);
}

function exchangeRefusal(err: unknown): Refusal {
  return err instanceof WorkosError && err.code === 'email_verification_required' ? 'unverified' : 'failed';
}

async function callback(res: ServerResponse, deps: AuthApiDeps, query: URLSearchParams): Promise<void> {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
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
    redirect(res, withHash(returnTo, await landing(cfg, deps, started, query.get('code') ?? '', now)));
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'auth: the code exchange failed');
    redirect(res, withHash(returnTo, refusedHash(exchangeRefusal(err))));
  }
}

async function tokensPayload(t: Tokens, cfg: WorkosConfig, deps: AuthApiDeps): Promise<Record<string, unknown>> {
  const name = t.organization === null ? null : await organizationName(cfg, t.organization);
  const picture = (await deps.users.avatar(t.user.id)) ?? t.user.picture;
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    organization: t.organization,
    organizationName: name,
    organizationSlug: t.organization === null ? null : await deps.slugs.ensure(t.organization, name),
    user: { ...t.user, picture },
  };
}

async function updateAccount(req: IncomingMessage, session: Session, deps: AuthApiDeps): Promise<unknown> {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  const body = await readJsonBody(req, AVATAR_BODY_MAX);
  const hasName = isRecord(body) && 'name' in body;
  const hasAvatar = isRecord(body) && 'avatar' in body;
  if (!hasName && !hasAvatar) throw new ApiError('send a name or an avatar', 400);
  if (hasName) {
    const parsed = parseAccountName(body.name);
    await updateUserName(cfg, session.userId, parsed.first, parsed.last);
  }
  if (hasAvatar) await deps.users.setAvatar(session.userId, parseAvatar(body.avatar));
  log.info({ user: session.userId, name: hasName, avatar: hasAvatar }, 'auth: account changed');
  return { ok: true };
}

async function exchange(req: IncomingMessage, deps: AuthApiDeps): Promise<unknown> {
  const body = await readJsonBody(req);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  const tokens = take(handoffs, code, HANDOFF_TTL_MS, (deps.now ?? Date.now)());
  if (tokens === null) throw new ApiError('that sign-in has already been used or has expired', 404);
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  return tokensPayload(tokens, cfg, deps);
}

async function refresh(req: IncomingMessage, deps: AuthApiDeps): Promise<unknown> {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  const body = await readJsonBody(req);
  const refreshToken = isRecord(body) && typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (refreshToken === '') throw new ApiError('refreshToken is required', 400);
  try {
    const fresh = await refreshTokens(cfg, refreshToken);
    if (!(await stillIn(deps.users, fresh))) throw new ApiError('this account is not on Metro any more', 401);
    return await tokensPayload(fresh, cfg, deps);
  } catch (err) {
    if (err instanceof WorkosError) throw new ApiError(err.status === 401 ? 'the session has ended, sign in again' : err.message, err.status);
    throw err;
  }
}

async function logout(session: Session, deps: AuthApiDeps): Promise<unknown> {
  const cfg = deps.config();
  if (cfg !== null) await revokeSession(cfg, session.sessionId).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'auth: the sign-out was not confirmed by WorkOS');
  });
  return { ok: true };
}

async function switchOrg(req: IncomingMessage, session: Session, deps: AuthApiDeps): Promise<unknown> {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  const body = await readJsonBody(req);
  const organization = isRecord(body) && typeof body.organization === 'string' ? body.organization : '';
  const refreshToken = isRecord(body) && typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (refreshToken === '') throw new ApiError('refreshToken is required', 400);
  const mine = await userOrganizations(cfg, session.userId);
  if (!mine.some((o) => o.id === organization)) throw new ApiError('you are not a member of that organization', 404);
  log.info({ user: session.userId, organization }, 'auth: switched organization');
  return tokensPayload(await refreshTokens(cfg, refreshToken, organization), cfg, deps);
}

async function agentsPayload(deps: AuthApiDeps, organization: string): Promise<{ agents?: Record<string, unknown>[] }> {
  if (deps.agentsOf === undefined) return {};
  const rows = await deps.agentsOf(organization);
  return { agents: rows.map((a) => ({ id: a.id, host: a.host, name: a.name, slug: a.slug, avatar: a.avatar })) };
}

const mePayload = (s: Session): Record<string, unknown> => ({ userId: s.userId, organization: s.organization, role: s.role, expiresAt: s.expiresAt });

async function createOrg(req: IncomingMessage, session: Session, deps: AuthApiDeps): Promise<unknown> {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  const body = await readJsonBody(req);
  const name = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : '';
  const refreshToken = isRecord(body) && typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (!ORGANIZATION_NAME_RE.test(name)) throw new ApiError('the organization name must be 2 to 64 characters', 400);
  if (refreshToken === '') throw new ApiError('refreshToken is required', 400);
  if (!(await mayCreateOrganization(deps.users, session.userId)))
    throw new ApiError('Creating an organization needs an approved account. Join the waitlist, and you can create one once you are let in.', 403);
  const organization = await createOrganization(cfg, name);
  await addMembership(cfg, session.userId, organization, 'admin');
  log.info({ user: session.userId, organization, name }, 'auth: organization created');
  return tokensPayload(await refreshTokens(cfg, refreshToken, organization), cfg, deps);
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
  '/email/start': { method: 'POST', run: startEmailCode },
  '/email/verify': { method: 'POST', run: (req, deps) => verifyEmailCode(req, deps, admitted) },
};

const PRIVATE: Record<string, PrivateRoute> = {
  '/me': { method: 'GET', run: (_req, _deps, session) => Promise.resolve(mePayload(session)) },
  '/logout': { method: 'POST', run: (_req, deps, session) => logout(session, deps) },
  '/organization': { method: 'POST', run: (req, deps, session) => createOrg(req, session, deps) },
  '/organizations': {
    method: 'GET',
    run: async (_req, deps, session) => {
      const cfg = deps.config();
      if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
      const mine = await userOrganizations(cfg, session.userId);
      return { organizations: await Promise.all(mine.map(async (o) => ({ ...o, slug: await deps.slugs.ensure(o.id, o.name), ...(await agentsPayload(deps, o.id)) }))) };
    },
  },
  '/switch': { method: 'POST', run: (req, deps, session) => switchOrg(req, session, deps) },
  '/account': { method: 'PUT', run: (req, deps, session) => updateAccount(req, session, deps) },
};

async function navigation(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps, path: string, query: URLSearchParams): Promise<boolean> {
  if (path !== '/login' && path !== '/callback') return false;
  if ((req.method ?? 'GET') !== 'GET') throw new ApiError('method not allowed', 405);
  if (path === '/login') login(req, res, deps, query);
  else await callback(res, deps, query);
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
