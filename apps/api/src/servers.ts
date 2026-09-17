import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { signedIdentity } from '@metro-labs/http/signed-identity';
import type { ServerEntry } from './server-types.js';
import { parseId } from '@metro-labs/core/ids';
import { AVATAR_BODY_MAX } from './avatar.js';

const PREFIX = '/api/servers';

export interface ServersApiDeps {
  list: (subject: string) => Promise<ServerEntry[]>;
  add: (subject: string, body: unknown) => Promise<ServerEntry>;
  rename: (subject: string, id: string, body: unknown) => Promise<ServerEntry>;
  remove: (subject: string, id: string) => Promise<{ id: string; host: string }>;
  avatar: (subject: string, id: string, body: unknown) => Promise<ServerEntry>;
}

type Known = { kind: 'index' } | { kind: 'server'; id: string } | { kind: 'avatar'; id: string };
type Target = Known | { kind: 'unknown' } | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = parseId(segments[0] ?? '');
  if (id === null) return { kind: 'unknown' };
  if (segments.length === 1) return { kind: 'server', id };
  return segments.length === 2 && segments[1] === 'avatar' ? { kind: 'avatar', id } : { kind: 'unknown' };
}

const ALLOWED: Record<Known['kind'], string[]> = { index: ['GET', 'POST'], server: ['PUT', 'DELETE'], avatar: ['PUT'] };

async function answer(req: IncomingMessage, deps: ServersApiDeps, owner: string, tgt: Known): Promise<unknown> {
  if (tgt.kind === 'index')
    return req.method === 'GET' ? { servers: await deps.list(owner) } : deps.add(owner, await readJsonBody(req));
  if (tgt.kind === 'avatar') return deps.avatar(owner, tgt.id, await readJsonBody(req, AVATAR_BODY_MAX));
  return req.method === 'DELETE' ? deps.remove(owner, tgt.id) : deps.rename(owner, tgt.id, await readJsonBody(req));
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServersApiDeps, tgt: Known): Promise<void> {
  try {
    const owner = await signedIdentity(req);
    if (owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    const body = await answer(req, deps, owner, tgt);
    if (req.method !== 'GET') log.info({ method: req.method, target: tgt }, 'servers-api: list changed');
    sendJson(req, res, 200, body);
  } catch (err) {
    apiFailure(req, res, err, 'servers-api');
  }
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
