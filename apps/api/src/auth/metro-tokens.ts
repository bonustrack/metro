import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { createSession, revokeSession, rotateSession, usableSession, type NewSessionMethod } from '../db/auth-sessions.js';
import type { Database } from '../db/client.js';
import type { UserLogin, UserStore } from '../users.js';
import type { Directory } from './directory.js';
import type { OAuthProviders } from './providers.js';
import { mintAccessToken, type AuthKeys } from './signing-keys.js';

export interface AccountDeps {
  directory: Directory;
  db?: () => Database;
  signing?: AuthKeys;
  providers?: OAuthProviders;
  users: UserStore;
  now?: () => number;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  organization: string | null;
  user: UserLogin;
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

const nowOf = (deps: Pick<AccountDeps, 'now'>): number => (deps.now ?? Date.now)();

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

export const landingOrganization = (deps: AccountDeps, user: string): Promise<Placement | null> => deps.directory.landingOrganization(user);

async function remember(deps: AccountDeps, user: string, place: Placement | null): Promise<void> {
  if (place === null) return;
  await deps.directory
    .rememberOrganization(user, place.id)
    .catch((err: unknown) => {
      log.warn({ user, organization: place.id, err: errMsg(err) }, 'auth: the organization the user is in was not kept for the next sign-in');
    });
}

async function placed(deps: AccountDeps, user: string, organization: string | undefined): Promise<Placement | null> {
  if (organization === undefined) return null;
  const found = (await deps.directory.userOrganizations(user)).find((o) => o.id === organization);
  if (found !== undefined) return found;
  log.info({ user, organization }, 'auth: a refresh asked for an organization the user is not in');
  throw ended();
}

export async function userLoginOf(users: UserStore, id: string): Promise<UserLogin | null> {
  const record = await users.find(id);
  return record === null ? null : { id: record.id, email: record.email, name: record.name, picture: record.picture, createdAt: record.createdAt };
}

export async function startSession(deps: AccountDeps, user: UserLogin, method: NewSessionMethod, place: Placement | null): Promise<Tokens> {
  signingOf(deps);
  const made = await createSession(dbOf(deps), { user: user.id, method, now: nowOf(deps) });
  log.info({ user: user.id, session: made.session.id, method }, 'auth: Metro session started');
  await remember(deps, user.id, place);
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

export async function checkRefresh(deps: AccountDeps, refreshToken: string, user: string): Promise<void> {
  const session = await usableSession(dbOf(deps), refreshToken, nowOf(deps));
  if (session?.user === user) return;
  log.info({ user, known: session !== null }, 'auth: a refresh token that does not work for this user was sent, so nothing was done');
  throw ended();
}

export interface RenewRequest {
  refreshToken: string;
  organization?: string;
  expectUser?: string;
  remember?: boolean;
}

export async function renewSession(deps: AccountDeps, { refreshToken, organization, expectUser, remember: chosen }: RenewRequest): Promise<Tokens> {
  const held = await rotated(deps, refreshToken);
  if (expectUser !== undefined && held.user.id !== expectUser) {
    log.warn({ bearer: expectUser, session: held.sessionId }, 'auth: a refresh token of another user was sent with this sign-in');
    throw ended();
  }
  const place = await placed(deps, held.user.id, organization);
  if (chosen === true) await remember(deps, held.user.id, place);
  return mint(deps, held, place);
}

export async function endSession(deps: AccountDeps, sessionId: string): Promise<boolean> {
  return deps.db === undefined ? false : revokeSession(deps.db(), sessionId, nowOf(deps));
}
