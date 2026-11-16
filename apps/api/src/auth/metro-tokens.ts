import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { createSession, isMetroRefreshToken, revokeSession, rotateSession, type SessionMethod } from '../db/auth-sessions.js';
import type { Database } from '../db/client.js';
import type { UserLogin, UserStore } from '../users.js';
import type { AccountsMode } from './accounts-mode.js';
import { workosDirectory, type Directory } from './directory.js';
import type { OAuthProviders } from './providers.js';
import { RateLimit } from './rate-limit.js';
import { mintAccessToken, type AuthKeys } from './signing-keys.js';
import { refreshRefusal, refreshTokens, WorkosError, type Tokens, type WorkosConfig } from './workos.js';

export interface AccountDeps {
  accounts?: AccountsMode;
  config: () => WorkosConfig | null;
  directory?: Directory;
  db?: () => Database;
  signing?: AuthKeys;
  providers?: OAuthProviders;
  users: UserStore;
  now?: () => number;
}

export interface Placement {
  id: string;
  role: string | null;
}

interface Held {
  sessionId: string;
  refreshToken: string;
  user: UserLogin;
}

export const modeOf = (deps: Pick<AccountDeps, 'accounts'>): AccountsMode => deps.accounts ?? 'workos';

export const directoryOf = (deps: Pick<AccountDeps, 'directory' | 'config'>): Directory => deps.directory ?? workosDirectory(deps.config);

export const usesMetroSessions = (deps: Pick<AccountDeps, 'accounts'>, refreshToken: string): boolean => modeOf(deps) === 'metro' || isMetroRefreshToken(refreshToken);

const nowOf = (deps: Pick<AccountDeps, 'now'>): number => (deps.now ?? Date.now)();

const WORKOS_REFRESH_RE = /^[\x21-\x7e]{16,2048}$/;

const exchanges = new RateLimit(20, 60_000);

const ended = (): ApiError => new ApiError('the session has ended, sign in again', 401);

function dbOf(deps: AccountDeps): Database {
  if (deps.db === undefined) throw new ApiError('Metro accounts are not set up on this server', 503);
  return deps.db();
}

function signingOf(deps: AccountDeps): AuthKeys {
  const signing = deps.signing;
  if (signing === undefined || signing.signer === null) throw new ApiError('Metro sign-in tokens are not set up on this server: METRO_AUTH_SIGNING_KEY is unset', 503);
  return signing;
}

const roleOf = (role: string | null): 'admin' | 'member' => (role === 'admin' ? 'admin' : 'member');

function mint(deps: AccountDeps, held: Held, place: Placement | null): Tokens {
  const organization = place === null ? {} : { org_id: place.id, role: roleOf(place.role) };
  const accessToken = mintAccessToken(signingOf(deps), { sub: held.user.id, sid: held.sessionId, ...organization }, nowOf(deps));
  return { accessToken, refreshToken: held.refreshToken, organization: place?.id ?? null, user: held.user };
}

export const landingOrganization = (deps: AccountDeps, user: string): Promise<Placement | null> => directoryOf(deps).landingOrganization(user);

async function placed(deps: AccountDeps, user: string, organization: string | undefined): Promise<Placement | null> {
  if (organization === undefined) return null;
  const found = (await directoryOf(deps).userOrganizations(user)).find((o) => o.id === organization);
  if (found !== undefined) return found;
  log.info({ user, organization }, 'auth: a refresh asked for an organization the user is not in');
  throw ended();
}

export async function userLoginOf(users: UserStore, id: string): Promise<UserLogin | null> {
  const record = await users.find(id);
  return record === null ? null : { id: record.id, email: record.email, name: record.name, picture: record.picture, createdAt: record.createdAt };
}

export async function startSession(deps: AccountDeps, user: UserLogin, method: SessionMethod, place: Placement | null, link?: string): Promise<Tokens> {
  signingOf(deps);
  const made = await createSession(dbOf(deps), { user: user.id, method, now: nowOf(deps), ...(link === undefined ? {} : { link }) });
  log.info({ user: user.id, session: made.session.id, method, link }, 'auth: Metro session started');
  return mint(deps, { sessionId: made.session.id, refreshToken: made.refreshToken, user }, place);
}

async function rotated(deps: AccountDeps, refreshToken: string): Promise<Held> {
  const rotation = await rotateSession(dbOf(deps), refreshToken, nowOf(deps));
  if (rotation.kind === 'refused') {
    if (rotation.reason === 'reused') log.warn('auth: a refresh token was used again after it was replaced, so its whole session is revoked');
    else log.info({ reason: rotation.reason }, 'auth: a refresh was refused');
    throw ended();
  }
  const user = await userLoginOf(deps.users, rotation.session.user);
  if (user === null) throw ended();
  return { sessionId: rotation.session.id, refreshToken: rotation.refreshToken, user };
}

async function workosUser(deps: AccountDeps, workosToken: string, address: string): Promise<UserLogin> {
  const cfg = deps.config();
  if (cfg === null || !WORKOS_REFRESH_RE.test(workosToken)) throw ended();
  if (!exchanges.spend(address, nowOf(deps))) throw new ApiError('Too many tries. Wait a minute, then try again.', 429);
  try {
    const t = await refreshTokens(cfg, workosToken);
    return t.emailVerified === true ? t.user : { ...t.user, email: null };
  } catch (err) {
    if (err instanceof WorkosError) throw refreshRefusal(err);
    throw err;
  }
}

async function exchanged(deps: AccountDeps, workosToken: string, address: string): Promise<Held> {
  signingOf(deps);
  const fromWorkos = await workosUser(deps, workosToken, address);
  if ((await deps.users.find(fromWorkos.id)) === null) await deps.users.noteLogin(fromWorkos, new Date(nowOf(deps)).toISOString());
  const user = (await userLoginOf(deps.users, fromWorkos.id)) ?? fromWorkos;
  const made = await createSession(dbOf(deps), { user: user.id, method: 'workos', now: nowOf(deps) });
  log.info({ user: user.id, session: made.session.id }, 'auth: a WorkOS session moved to a Metro session');
  return { sessionId: made.session.id, refreshToken: made.refreshToken, user };
}

export interface RenewRequest {
  refreshToken: string;
  organization?: string;
  expectUser?: string;
  address: string;
}

export async function renewSession(deps: AccountDeps, { refreshToken, organization, expectUser, address }: RenewRequest): Promise<Tokens> {
  const held = isMetroRefreshToken(refreshToken) ? await rotated(deps, refreshToken) : await exchanged(deps, refreshToken, address);
  if (expectUser !== undefined && held.user.id !== expectUser) {
    log.warn({ bearer: expectUser, session: held.sessionId }, 'auth: a refresh token of another user was sent with this sign-in');
    throw ended();
  }
  return mint(deps, held, await placed(deps, held.user.id, organization));
}

export async function endSession(deps: AccountDeps, sessionId: string): Promise<boolean> {
  return deps.db === undefined ? false : revokeSession(deps.db(), sessionId, nowOf(deps));
}
