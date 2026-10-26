import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import { ADD_AGENT_ADMIN, type ServerEntry } from './server-types.js';
import { parseId } from '@metro-labs/core/ids';
import { AVATAR_BODY_MAX } from './avatar.js';
import { callerOf } from './server-route.js';

const PREFIX = '/api/servers';

export interface ServersApiDeps {
  list: (subject: string) => Promise<ServerEntry[]>;
  add: (subject: string, body: unknown) => Promise<ServerEntry>;
  addRemote: (subject: string, body: unknown) => Promise<ServerEntry>;
  rename: (subject: string, id: string, body: unknown) => Promise<ServerEntry>;
  remove: (session: Session, id: string) => Promise<{ id: string; host: string | null }>;
  avatar: (subject: string, id: string, body: unknown) => Promise<ServerEntry>;
  move: (session: Session, id: string, body: unknown) => Promise<ServerEntry>;
  keys: SigningKeys;
}

type Known = { kind: 'index' } | { kind: 'server'; id: string } | { kind: 'avatar'; id: string } | { kind: 'move'; id: string };
type Target = Known | { kind: 'unknown' } | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  return idTarget(path.slice(PREFIX.length + 1).split('/').filter(Boolean));
}

function idTarget(segments: string[]): Target {
  const id = parseId(segments[0] ?? '');
  if (id === null) return { kind: 'unknown' };
  if (segments.length === 1) return { kind: 'server', id };
  if (segments.length !== 2) return { kind: 'unknown' };
  if (segments[1] === 'avatar') return { kind: 'avatar', id };
  return segments[1] === 'move' ? { kind: 'move', id } : { kind: 'unknown' };
}

const ALLOWED: Record<Known['kind'], string[]> = { index: ['GET', 'POST'], server: ['PUT', 'DELETE'], avatar: ['PUT'], move: ['POST'] };

const isRemote = (body: unknown): boolean => isRecord(body) && body.kind === 'remote';

async function added(deps: ServersApiDeps, session: Session, body: unknown): Promise<ServerEntry> {
  const owner = session.organization ?? '';
  if (session.role !== 'admin') throw new ApiError(ADD_AGENT_ADMIN, 403);
  return isRemote(body) ? deps.addRemote(owner, body) : deps.add(owner, body);
}

async function listed(deps: ServersApiDeps, owner: string): Promise<{ servers: ServerEntry[] }> {
  return { servers: await deps.list(owner) };
}

async function answer(req: IncomingMessage, deps: ServersApiDeps, session: Session, tgt: Known): Promise<unknown> {
  const owner = session.organization ?? '';
  if (tgt.kind === 'move') return deps.move(session, tgt.id, await readJsonBody(req));
  if (tgt.kind === 'index')
    return req.method === 'GET' ? listed(deps, owner) : added(deps, session, await readJsonBody(req));
  if (tgt.kind === 'avatar') return deps.avatar(owner, tgt.id, await readJsonBody(req, AVATAR_BODY_MAX));
  return req.method === 'DELETE' ? deps.remove(session, tgt.id) : deps.rename(owner, tgt.id, await readJsonBody(req));
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServersApiDeps, tgt: Known): Promise<void> {
  const { session } = await callerOf(req, deps.keys);
  const body = await answer(req, deps, session, tgt);
  if (req.method !== 'GET') log.info({ method: req.method, target: tgt }, 'servers-api: list changed');
  sendJson(req, res, 200, body);
}

export function handleServersApiRequest(req: IncomingMessage, res: ServerResponse, deps: ServersApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const tgt = target(path);
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such server' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, tgt).catch((err: unknown) => {
    apiFailure(req, res, err, 'servers-api');
  });
  return true;
}
