import type { IncomingMessage } from 'node:http';
import { log, errMsg } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, stringOf } from '@metro-labs/http/api-http';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import type { SlugStore } from '../slug.js';
import type { ServerEntry } from '../server-types.js';
import { parseAccountName } from '../users.js';
import { AVATAR_BODY_MAX, parseAvatar, type OrganizationAvatars } from '../avatar.js';
import { isOperator, mayCreateOrganization, stillIn } from './operator.js';
import { clientAddress } from './rate-limit.js';
import { directoryOf, endSession, modeOf, renewSession, usesMetroSessions, type AccountDeps } from './metro-tokens.js';
import { configOf, ORGANIZATION_NAME_RE, refreshRefusal, refreshTokens, revokeSession, WorkosError, type Tokens } from './workos.js';

export interface AuthApiDeps extends AccountDeps {
  keys: SigningKeys;
  slugs: SlugStore;
  orgAvatars: OrganizationAvatars;
  agentsOf?: (organization: string) => Promise<ServerEntry[]>;
  publicBase?: (req: IncomingMessage) => string;
  stateKey?: Buffer | null;
}

export async function tokensPayload(t: Tokens, deps: AuthApiDeps): Promise<Record<string, unknown>> {
  const name = t.organization === null ? null : await directoryOf(deps).organizationName(t.organization);
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

export async function updateAccount(req: IncomingMessage, session: Session, deps: AuthApiDeps): Promise<unknown> {
  const body = await readJsonBody(req, AVATAR_BODY_MAX);
  const hasName = isRecord(body) && 'name' in body;
  const hasAvatar = isRecord(body) && 'avatar' in body;
  if (!hasName && !hasAvatar) throw new ApiError('send a name or an avatar', 400);
  if (hasName) {
    const parsed = parseAccountName(body.name);
    await directoryOf(deps).updateUserName(session.userId, parsed.first, parsed.last);
  }
  if (hasAvatar) await deps.users.setAvatar(session.userId, parseAvatar(body.avatar));
  log.info({ user: session.userId, name: hasName, avatar: hasAvatar }, 'auth: account changed');
  return { ok: true };
}

interface Renewal {
  req: IncomingMessage;
  refreshToken: string;
  organization?: string;
  expectUser?: string;
  remember?: boolean;
}

function renewed(deps: AuthApiDeps, renewal: Renewal): Promise<Tokens> {
  if (usesMetroSessions(deps, renewal.refreshToken)) return renewSession(deps, { ...renewal, address: clientAddress(renewal.req) });
  return refreshTokens(configOf(deps), renewal.refreshToken, renewal.organization);
}

async function workosRefusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WorkosError) throw refreshRefusal(err);
    throw err;
  }
}

export async function refresh(req: IncomingMessage, deps: AuthApiDeps): Promise<unknown> {
  const body = await readJsonBody(req);
  const refreshToken = stringOf(bodyField(body, 'refreshToken'));
  const organization = stringOf(bodyField(body, 'organization'));
  if (refreshToken === '') throw new ApiError('refreshToken is required', 400);
  return workosRefusals(async () => {
    const fresh = await renewed(deps, { req, refreshToken, ...(organization === '' ? {} : { organization }) });
    if (!(await stillIn(deps.users, fresh, modeOf(deps)))) throw new ApiError('this account is not on Metro any more', 401);
    return tokensPayload(fresh, deps);
  });
}

export async function logout(session: Session, deps: AuthApiDeps): Promise<unknown> {
  if (await endSession(deps, session.sessionId)) {
    log.info({ user: session.userId }, 'auth: signed out');
    return { ok: true };
  }
  const cfg = deps.config();
  if (cfg !== null) await revokeSession(cfg, session.sessionId).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'auth: the sign-out was not confirmed by WorkOS');
  });
  return { ok: true };
}

const refreshOf = (body: unknown): string => {
  const refreshToken = isRecord(body) && typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (refreshToken === '') throw new ApiError('refreshToken is required', 400);
  return refreshToken;
};

export async function switchOrg(req: IncomingMessage, session: Session, deps: AuthApiDeps): Promise<unknown> {
  const body = await readJsonBody(req);
  const organization = isRecord(body) && typeof body.organization === 'string' ? body.organization : '';
  const refreshToken = refreshOf(body);
  const mine = await directoryOf(deps).userOrganizations(session.userId);
  if (!mine.some((o) => o.id === organization)) throw new ApiError('you are not a member of that organization', 404);
  try {
    const remember = !(isRecord(body) && body.remember === false);
    const payload = await tokensPayload(await renewed(deps, { req, refreshToken, organization, expectUser: session.userId, remember }), deps);
    log.info({ user: session.userId, organization }, 'auth: switched organization');
    return payload;
  } catch (err) {
    log.warn({ user: session.userId, organization, err: errMsg(err) }, 'auth: the organization switch failed');
    if (err instanceof WorkosError) throw refreshRefusal(err);
    throw err;
  }
}

async function agentsPayload(deps: AuthApiDeps, organization: string): Promise<{ agents?: Record<string, unknown>[] }> {
  if (deps.agentsOf === undefined) return {};
  const rows = await deps.agentsOf(organization);
  return { agents: rows.map((a) => ({ id: a.id, host: a.host, name: a.name, slug: a.slug, avatar: a.avatar })) };
}

export async function organizationsOf(deps: AuthApiDeps, session: Session): Promise<unknown> {
  const mine = await directoryOf(deps).userOrganizations(session.userId);
  const avatars = await deps.orgAvatars.avatars(mine.map((o) => o.id));
  return { organizations: await Promise.all(mine.map(async (o) => ({ ...o, slug: await deps.slugs.ensure(o.id, o.name), avatar: avatars.get(o.id) ?? null, ...(await agentsPayload(deps, o.id)) }))) };
}

export async function mePayload(s: Session, deps: AuthApiDeps): Promise<Record<string, unknown>> {
  const me = await deps.users.find(s.userId);
  return { userId: s.userId, organization: s.organization, role: s.role, expiresAt: s.expiresAt, operator: isOperator(me ?? { id: s.userId, email: null }, modeOf(deps)) };
}

export async function createOrg(req: IncomingMessage, session: Session, deps: AuthApiDeps): Promise<unknown> {
  const body = await readJsonBody(req);
  const name = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : '';
  if (!ORGANIZATION_NAME_RE.test(name)) throw new ApiError('the organization name must be 2 to 64 characters', 400);
  const refreshToken = refreshOf(body);
  if (modeOf(deps) === 'workos') configOf(deps);
  if (!(await mayCreateOrganization(deps.users, session.userId, modeOf(deps))))
    throw new ApiError('Creating an organization needs an approved account. Join the waitlist, and you can create one once you are let in.', 403);
  const organization = await directoryOf(deps).createOrganization(name, session.userId);
  log.info({ user: session.userId, organization, name }, 'auth: organization created');
  return tokensPayload(await renewed(deps, { req, refreshToken, organization, expectUser: session.userId, remember: true }), deps);
}
