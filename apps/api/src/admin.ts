import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import { isOperatorEmail } from './auth/operator.js';
import { listOrganizations, type WorkosConfig } from './auth/workos.js';
import type { AgentSummary } from './db/servers.js';
import type { SlugStore } from './slug.js';
import { isUserStatus, type UserStore } from './users.js';

const PREFIX = '/api/admin';
const STATUS_RE = /^\/users\/([A-Za-z0-9_]+)\/status$/;

export interface AdminApiDeps {
  config: () => WorkosConfig | null;
  keys: SigningKeys;
  users: UserStore;
  slugs: SlugStore;
  agents: () => Promise<AgentSummary[]>;
}

async function operator(req: IncomingMessage, deps: AdminApiDeps): Promise<Session> {
  const session = await bearerSession(req, deps.keys);
  if (session === null) throw new ApiError('unauthorized', 401);
  const me = await deps.users.find(session.userId);
  if (!isOperatorEmail(me?.email ?? null)) throw new ApiError('this page is for the Metro operator', 403);
  return session;
}

async function listUsers(deps: AdminApiDeps): Promise<unknown> {
  const rows = await deps.users.list();
  return {
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      picture: r.avatar ?? r.picture,
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
      status: r.status,
      operator: isOperatorEmail(r.email),
    })),
  };
}

async function setStatus(req: IncomingMessage, deps: AdminApiDeps, session: Session, user: string): Promise<unknown> {
  const body = await readJsonBody(req);
  const status = isRecord(body) ? body.status : undefined;
  if (!isUserStatus(status)) throw new ApiError('status must be approved, waitlist or rejected', 400);
  const target = await deps.users.find(user);
  if (target === null) throw new ApiError('no such user', 404);
  if (isOperatorEmail(target.email)) throw new ApiError('the operator account cannot be changed', 400);
  await deps.users.setStatus(user, status);
  log.info({ by: session.userId, user, status }, 'admin: user status changed');
  return { ok: true, status };
}

async function organizations(deps: AdminApiDeps): Promise<unknown> {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  const rows = await listOrganizations(cfg);
  return { organizations: await Promise.all(rows.map(async (o) => ({ ...o, slug: await deps.slugs.ensure(o.id, o.name) }))) };
}

async function agentsList(deps: AdminApiDeps): Promise<unknown> {
  const rows = await deps.agents();
  const cfg = deps.config();
  const named = cfg === null ? [] : await listOrganizations(cfg);
  const orgs = new Map(named.map((o) => [o.id, o.name]));
  return { agents: rows.map((a) => ({ ...a, organizationName: orgs.get(a.owner) ?? null })) };
}

async function answer(req: IncomingMessage, res: ServerResponse, deps: AdminApiDeps, path: string): Promise<void> {
  const session = await operator(req, deps);
  const method = req.method ?? 'GET';
  const status = STATUS_RE.exec(path);
  if (status !== null && method === 'POST') {
    sendJson(req, res, 200, await setStatus(req, deps, session, status[1] ?? ''));
    return;
  }
  if (method !== 'GET') throw new ApiError('method not allowed', 405);
  if (path === '/users') sendJson(req, res, 200, await listUsers(deps));
  else if (path === '/organizations') sendJson(req, res, 200, await organizations(deps));
  else if (path === '/agents') sendJson(req, res, 200, await agentsList(deps));
  else throw new ApiError('not found', 404);
}

export function handleAdminApiRequest(req: IncomingMessage, res: ServerResponse, deps: AdminApiDeps): boolean {
  const full = req.url ?? '';
  if (!full.startsWith(`${PREFIX}/`)) return false;
  const path = (full.split('?', 1)[0] ?? '').slice(PREFIX.length).replace(/\/$/, '');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  answer(req, res, deps, path).catch((err: unknown) => {
    apiFailure(req, res, err, 'admin-api');
  });
  return true;
}
