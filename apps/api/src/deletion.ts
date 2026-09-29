import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult } from './launch-config.js';
import type { DeletionRow } from './db/servers.js';
import type { Ec2Target } from './aws/resize.js';
import { DeletionRefused, isEntryOnly, planDeletion, runDeletion, type Confirmed, type DeletionAws, type Outcome, type Owned, type Plan } from './aws/deletion.js';
import { fromAws } from './size.js';

const PATH_RE = /^\/api\/servers\/([^/]+)\/deletion\/?$/;
const OFF = 'This Metro deployment has no AWS account, so it cannot delete a server.';
const NO_REGION = 'Metro has no AWS region for this server, so it cannot check it on AWS.';

export interface DeletionCore {
  config: () => ConfigResult;
  remove: (owner: string, id: string) => Promise<unknown>;
  resizing: (region: string, instanceId: string) => boolean;
  aws: DeletionAws;
}

export interface DeletionApiDeps extends DeletionCore {
  lookup: (owner: string, id: string) => Promise<DeletionRow>;
  keys: SigningKeys;
}

interface Resolved {
  row: DeletionRow;
  target: Ec2Target | null;
  owned: Owned;
}

const claims = new Set<string>();

export function resetDeletionState(): void {
  claims.clear();
}

const labelOf = (row: DeletionRow): string => row.name ?? row.host;

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await fromAws(work);
  } catch (err) {
    if (err instanceof DeletionRefused) throw new ApiError(err.message, 409);
    throw err;
  }
}

function resolve(deps: DeletionCore, row: DeletionRow): Resolved | string {
  const owned = { agentId: row.id, host: row.host, addedAt: row.addedAt };
  if (row.instanceId === null) return { row, target: null, owned };
  const config = deps.config();
  if (!config.ok) return OFF;
  if (row.region === null) return NO_REGION;
  return { row, target: { credentials: config.config.credentials, region: row.region, instanceId: row.instanceId }, owned };
}

const viewOf = (row: DeletionRow, plan: Plan): Record<string, unknown> => ({
  deletable: true,
  entryOnly: isEntryOnly(plan),
  name: labelOf(row),
  host: row.host,
  node: plan.node,
  region: plan.region,
  instanceId: plan.instanceId,
  state: plan.state,
  type: plan.type,
  volumes: plan.disks.map((d) => ({ volumeId: d.volumeId, sizeGib: d.sizeGib })),
});

export async function deletionView(deps: DeletionCore, row: DeletionRow): Promise<Record<string, unknown>> {
  const resolved = resolve(deps, row);
  if (typeof resolved === 'string') return { deletable: false, reason: resolved };
  return viewOf(resolved.row, await guarded(() => planDeletion(deps.aws, resolved.target, resolved.owned)));
}

function confirmedOf(body: unknown, row: DeletionRow): Confirmed {
  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const typed = typeof fields.name === 'string' ? fields.name.trim() : '';
  if (typed !== labelOf(row)) throw new ApiError(`type the name of the server, ${labelOf(row)}, to delete it`, 400);
  const { instanceId, state, volumeIds } = fields;
  if (typeof instanceId !== 'string' || typeof state !== 'string' || state === '' || !Array.isArray(volumeIds) || !volumeIds.every((v) => typeof v === 'string'))
    throw new ApiError('send the server id, its state and the disk ids the dialog showed', 400);
  return { instanceId, state, volumeIds: volumeIds.map(String) };
}

async function deleteAll(deps: DeletionCore, resolved: Resolved, confirmed: Confirmed, by: string): Promise<Outcome> {
  const { row, target, owned } = resolved;
  const { owner, id } = row;
  const key = target === null ? id : `${target.region}/${target.instanceId}`;
  if (claims.has(key)) throw new ApiError('this server is already being deleted', 409);
  claims.add(key);
  try {
    const outcome = await guarded(() => runDeletion(deps.aws, target, owned, confirmed));
    if (outcome.terminated) log.info({ by, owner, agent: id, region: row.region, ...outcome }, 'deletion: the server is deleted in AWS');
    else log.info({ by, owner, agent: id, host: row.host, instanceId: row.instanceId, state: confirmed.state }, 'deletion: entry only, nothing is deleted in AWS');
    await deps.remove(owner, id);
    log.info({ by, owner, agent: id, host: row.host }, 'deletion: the agent left the list');
    return outcome;
  } finally {
    claims.delete(key);
  }
}

export async function confirmDeletion(deps: DeletionCore, row: DeletionRow, body: unknown, by: string): Promise<Record<string, unknown>> {
  const resolved = resolve(deps, row);
  if (typeof resolved === 'string') throw new ApiError(resolved, 400);
  const confirmed = confirmedOf(body, row);
  const { target } = resolved;
  if (target !== null && deps.resizing(target.region, target.instanceId)) throw new ApiError('this server is changing size. Wait for it to finish', 409);
  const outcome = await deleteAll(deps, resolved, confirmed, by);
  return { deleted: true, name: labelOf(row), ...outcome };
}

export function noteRefusal(id: string, err: unknown): void {
  if (err instanceof ApiError && err.status === 409) log.warn({ agent: id, why: err.message }, 'deletion: refused');
}

async function remove(deps: DeletionApiDeps, session: Session, owner: string, id: string, body: unknown): Promise<unknown> {
  if (session.role !== 'admin') throw new ApiError('deleting a server needs the admin role in your organization', 403);
  return confirmDeletion(deps, await deps.lookup(owner, id), body, session.userId);
}

async function route(req: IncomingMessage, res: ServerResponse, deps: DeletionApiDeps, id: string): Promise<void> {
  try {
    const session = await bearerSession(req, deps.keys);
    const owner = session?.organization ?? null;
    if (session === null || owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    const body = req.method === 'GET' ? await deletionView(deps, await deps.lookup(owner, id)) : await remove(deps, session, owner, id, await readJsonBody(req));
    sendJson(req, res, 200, body);
  } catch (err) {
    noteRefusal(id, err);
    apiFailure(req, res, err, 'deletion-api');
  }
}

export function handleDeletionApiRequest(req: IncomingMessage, res: ServerResponse, deps: DeletionApiDeps): boolean {
  const match = PATH_RE.exec((req.url ?? '').split('?')[0] ?? '');
  if (match === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const id = parseId(match[1] ?? '');
  if (id === null) {
    sendJson(req, res, 404, { error: 'no such server' });
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, id).catch((err: unknown) => {
    apiFailure(req, res, err, 'deletion-api');
  });
  return true;
}
