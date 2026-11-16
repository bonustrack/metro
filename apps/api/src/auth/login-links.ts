import type { IncomingMessage } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody } from '@metro-labs/http/api-http';
import { APP_ORIGIN, appOriginOf } from '@metro-labs/http/approval-rules';
import { revokeLinkSessions } from '../db/auth-sessions.js';
import type { Database } from '../db/client.js';
import { hasIdentity } from '../db/identities.js';
import { createLoginLink, currentLoginLinks, redeemLoginLink, revokeUserLoginLinks, type LoginLinkState } from '../db/login-links.js';
import type { UserStore } from '../users.js';
import type { AccountsMode } from './accounts-mode.js';
import { isOperator } from './operator.js';
import { clientAddress, RateLimit } from './rate-limit.js';

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface LinkDeps {
  accounts?: AccountsMode;
  db?: () => Database;
  users: UserStore;
  now?: () => number;
}

const redemptions = new RateLimit(30, 60_000);

function linkDb(deps: LinkDeps): Database {
  if (deps.accounts !== 'metro' || deps.db === undefined) throw new ApiError('Login links work once Metro keeps its own accounts (METRO_ACCOUNTS=metro).', 409);
  return deps.db();
}

const nowOf = (deps: LinkDeps): number => (deps.now ?? Date.now)();

export async function redeemLink(req: IncomingMessage, deps: LinkDeps, land: (user: string, link: string, now: number) => Promise<string>): Promise<unknown> {
  if (deps.accounts !== 'metro' || deps.db === undefined) throw new ApiError('not found', 404);
  const now = nowOf(deps);
  if (!redemptions.spend(clientAddress(req), now)) throw new ApiError('Too many tries. Wait a minute, then try again.', 429);
  const body = await readJsonBody(req);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  if (!CODE_RE.test(code)) throw new ApiError('that is not a login link', 400);
  const found = await redeemLoginLink(deps.db(), code, now);
  if (found === null) {
    log.info('auth: a login link that is used, expired or removed was tried');
    throw new ApiError('This login link does not work any more. Ask for a new one.', 404);
  }
  log.info({ user: found.user, link: found.id, by: found.createdBy }, 'auth: a login link was used');
  return { hash: await land(found.user, found.id, now) };
}

export const loginLinkUrl = (code: string, env: NodeJS.ProcessEnv = process.env): string => `${appOriginOf(env.METRO_APP_URL) ?? APP_ORIGIN}/#/auth/link/${code}`;

export async function makeLoginLink(deps: LinkDeps, user: string, by: string): Promise<{ id: string; url: string; createdAt: number; expiresAt: number }> {
  const db = linkDb(deps);
  const target = await deps.users.find(user);
  if (target === null) throw new ApiError('no such user', 404);
  if (isOperator(target, 'metro')) throw new ApiError('the operator cannot have a login link', 400);
  if (await hasIdentity(db, user)) throw new ApiError('this person signs in with Google or Microsoft, so a login link is not given to them', 400);
  const now = nowOf(deps);
  const made = await createLoginLink(db, { user, by, now });
  log.info({ user, link: made.id, by }, 'admin: login link made');
  return { id: made.id, url: loginLinkUrl(made.code), createdAt: now, expiresAt: made.expiresAt };
}

export async function removeLoginLink(deps: LinkDeps, user: string, by: string): Promise<{ revoked: boolean; sessions: number }> {
  const db = linkDb(deps);
  const now = nowOf(deps);
  const links = await revokeUserLoginLinks(db, user, now);
  const sessions = await revokeLinkSessions(db, links, now);
  log.info({ user, by, links: links.length, sessions }, 'admin: login links removed, with the sessions they made');
  return { revoked: links.length > 0, sessions };
}

export function loginLinksOf(deps: LinkDeps): Promise<Map<string, LoginLinkState>> {
  return deps.db === undefined ? Promise.resolve(new Map<string, LoginLinkState>()) : currentLoginLinks(deps.db());
}
