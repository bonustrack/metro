import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './log.js';
import { apiFailure, cors, readJsonBody, sendJson } from './api-http.js';
import { signedIdentity } from './signed-identity.js';
import type { ServerEntry } from './server-types.js';
import { parseId } from '../db/ids.js';

const PREFIX = '/api/servers';

export interface ServersApiDeps {
  list: (subject: string) => Promise<ServerEntry[]>;
  add: (subject: string, body: unknown) => Promise<ServerEntry>;
  rename: (subject: string, id: string, body: unknown) => Promise<ServerEntry>;
  remove: (subject: string, id: string) => Promise<{ id: string; host: string }>;
}

type Target = { kind: 'index' } | { kind: 'server'; id: string } | { kind: 'unknown' } | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = parseId(segments[0] ?? '');
  return id === null || segments.length !== 1 ? { kind: 'unknown' } : { kind: 'server', id };
}

const ALLOWED: Record<'index' | 'server', string[]> = { index: ['GET', 'POST'], server: ['PUT', 'DELETE'] };

async function answer(
  req: IncomingMessage,
  deps: ServersApiDeps,
  owner: string,
  tgt: { kind: 'index' } | { kind: 'server'; id: string },
): Promise<unknown> {
  if (tgt.kind === 'index')
    return req.method === 'GET' ? { servers: await deps.list(owner) } : deps.add(owner, await readJsonBody(req));
  return req.method === 'DELETE' ? deps.remove(owner, tgt.id) : deps.rename(owner, tgt.id, await readJsonBody(req));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServersApiDeps,
  tgt: { kind: 'index' } | { kind: 'server'; id: string },
): Promise<void> {
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
