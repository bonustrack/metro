import type { IncomingMessage } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody } from '@metro-labs/http/api-http';
import { APP_ORIGIN, appOriginOf } from '@metro-labs/http/approval-rules';
import type { Database } from '../db/client.js';
import { createLoginLink, liveLoginLinks, redeemLoginLink, revokeUserLoginLink, type LiveLoginLink } from '../db/login-links.js';
import type { AccountsMode } from './accounts-mode.js';

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const WINDOW_MS = 60_000;
const TRIES_PER_WINDOW = 30;
const TRACKED_MAX = 5000;

export interface LinkDeps {
  accounts?: AccountsMode;
  db?: () => Database;
  now?: () => number;
}

const tries = new Map<string, number[]>();

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const first = typeof value === 'string' ? value.split(',')[0]?.trim() : '';
  return first === undefined || first === '' ? null : first;
}

export const clientAddress = (req: IncomingMessage): string => header(req, 'cf-connecting-ip') ?? header(req, 'fly-client-ip') ?? req.socket.remoteAddress ?? 'unknown';

function spend(address: string, now: number): boolean {
  const recent = (tries.get(address) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= TRIES_PER_WINDOW) return false;
  tries.delete(address);
  tries.set(address, [...recent, now]);
  while (tries.size > TRACKED_MAX) {
    const first = tries.keys().next().value;
    if (first === undefined) break;
    tries.delete(first);
  }
  return true;
}

function linkDb(deps: LinkDeps): Database {
  if (deps.accounts !== 'metro' || deps.db === undefined) throw new ApiError('Login links work once Metro keeps its own accounts (METRO_ACCOUNTS=metro).', 409);
  return deps.db();
}

const nowOf = (deps: LinkDeps): number => (deps.now ?? Date.now)();

export async function redeemLink(req: IncomingMessage, deps: LinkDeps, land: (user: string, now: number) => Promise<string>): Promise<unknown> {
  if (deps.accounts !== 'metro' || deps.db === undefined) throw new ApiError('not found', 404);
  const now = nowOf(deps);
  if (!spend(clientAddress(req), now)) throw new ApiError('Too many tries. Wait a minute, then try again.', 429);
  const body = await readJsonBody(req);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  if (!CODE_RE.test(code)) throw new ApiError('that is not a login link', 400);
  const found = await redeemLoginLink(deps.db(), code, now);
  if (found === null) {
    log.info('auth: a login link that does not work any more was used');
    throw new ApiError('This login link does not work any more. Ask for a new one.', 404);
  }
  log.info({ user: found.user, link: found.id }, 'auth: a login link was used');
  return { hash: await land(found.user, now) };
}

export const loginLinkUrl = (code: string, env: NodeJS.ProcessEnv = process.env): string => `${appOriginOf(env.METRO_APP_URL) ?? APP_ORIGIN}/#/auth/link/${code}`;

export async function makeLoginLink(deps: LinkDeps, user: string, by: string): Promise<{ id: string; url: string; createdAt: number }> {
  const now = nowOf(deps);
  const made = await createLoginLink(linkDb(deps), { user, by, now });
  log.info({ user, link: made.id, by }, 'admin: login link made');
  return { id: made.id, url: loginLinkUrl(made.code), createdAt: now };
}

export async function removeLoginLink(deps: LinkDeps, user: string, by: string): Promise<{ revoked: boolean }> {
  const revoked = await revokeUserLoginLink(linkDb(deps), user, nowOf(deps));
  log.info({ user, by, revoked }, 'admin: login link removed');
  return { revoked };
}

export function loginLinksOf(deps: LinkDeps): Promise<Map<string, LiveLoginLink>> {
  return deps.db === undefined ? Promise.resolve(new Map<string, LiveLoginLink>()) : liveLoginLinks(deps.db());
}
