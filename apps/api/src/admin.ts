import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import { isOperatorEmail } from './auth/operator.js';
import { listOrganizations, organizationName, type WorkosConfig } from './auth/workos.js';
import type { AgentSummary, DeletionRow } from './db/servers.js';
import { confirmDeletion, deletionView, noteRefusal, type DeletionCore } from './deletion.js';
import type { SlugStore } from './slug.js';
import type { MetricsLink } from './db/usage.js';
import { parseLink, usageOf, type MetricsCore } from './usage.js';
import { isUserStatus, type UserStore } from './users.js';

const PREFIX = '/api/admin';
const STATUS_RE = /^\/users\/([A-Za-z0-9_]+)\/status$/;
const DELETION_RE = /^\/servers\/([^/]+)\/deletion$/;
const METRICS_RE = /^\/servers\/([^/]+)\/metrics$/;

export interface AdminDeletionDeps extends DeletionCore {
  lookup: (id: string) => Promise<DeletionRow>;
}

export interface AdminMetricsDeps extends MetricsCore {
  save: (id: string, link: MetricsLink | null) => Promise<void>;
}

export interface AdminApiDeps {
  config: () => WorkosConfig | null;
  keys: SigningKeys;
  users: UserStore;
  slugs: SlugStore;
  agents: () => Promise<AgentSummary[]>;
  deletion: AdminDeletionDeps;
  metrics: AdminMetricsDeps;
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

async function ownerView(deps: AdminApiDeps, row: DeletionRow): Promise<unknown> {
  const cfg = deps.config();
  const name = cfg === null ? null : await organizationName(cfg, row.owner);
  return { ...(await deletionView(deps.deletion, row)), owner: row.owner, organizationName: name };
}

async function serverDeletion(req: IncomingMessage, deps: AdminApiDeps, session: Session, id: string): Promise<unknown> {
  try {
    const row = await deps.deletion.lookup(id);
    if (req.method === 'GET') return await ownerView(deps, row);
    const who = { by: session.userId, owner: row.owner, agent: row.id, host: row.host };
    const body = await readJsonBody(req);
    log.info(who, 'admin: deleting a server for its organization');
    const done = await confirmDeletion(deps.deletion, row, body, session.userId);
    const what = done.terminated === true ? 'admin: server deleted for its organization' : 'admin: agent entry removed for its organization, entry only';
    log.info({ ...who, instanceId: done.instanceId, volumeIds: done.volumeIds, terminated: done.terminated }, what);
    return done;
  } catch (err) {
    noteRefusal(id, err);
    throw err;
  }
}

async function saveMetricsLink(req: IncomingMessage, deps: AdminApiDeps, session: Session, id: string): Promise<unknown> {
  const link = parseLink(await readJsonBody(req));
  if (link !== null) {
    const { usage } = await usageOf(deps.metrics, link, '24h');
    if (usage.cpu.points.length === 0)
      throw new ApiError(`CloudWatch has no CPU readings for ${link.instanceId} in ${link.region} in the last 24 hours. Check the instance id and the region, and that the server runs.`, 400);
  }
  await deps.metrics.save(id, link);
  log.info({ by: session.userId, agent: id, link }, 'admin: CloudWatch link saved');
  return { ok: true, link };
}

const LISTS = new Map<string, (deps: AdminApiDeps) => Promise<unknown>>([
  ['/users', listUsers],
  ['/organizations', organizations],
  ['/agents', agentsList],
]);

type ById = (req: IncomingMessage, deps: AdminApiDeps, session: Session, id: string) => Promise<unknown>;

const BY_ID: [RegExp, string[], ById][] = [
  [STATUS_RE, ['POST'], setStatus],
  [DELETION_RE, ['GET', 'POST'], serverDeletion],
  [METRICS_RE, ['PUT'], saveMetricsLink],
];

async function byId(req: IncomingMessage, deps: AdminApiDeps, session: Session, path: string, method: string): Promise<{ body: unknown } | null> {
  for (const [re, methods, handle] of BY_ID) {
    const match = re.exec(path);
    if (match !== null && methods.includes(method)) return { body: await handle(req, deps, session, match[1] ?? '') };
  }
  return null;
}

async function answer(req: IncomingMessage, res: ServerResponse, deps: AdminApiDeps, path: string): Promise<void> {
  const session = await operator(req, deps);
  const method = req.method ?? 'GET';
  const routed = await byId(req, deps, session, path, method);
  if (routed !== null) {
    sendJson(req, res, 200, routed.body);
    return;
  }
  if (method !== 'GET') throw new ApiError('method not allowed', 405);
  const list = LISTS.get(path);
  if (list === undefined) throw new ApiError('not found', 404);
  sendJson(req, res, 200, await list(deps));
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
