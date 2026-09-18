import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { signedIdentity } from '@metro-labs/http/signed-identity';
import { bearerSession, type SigningKeys } from '@metro-labs/http/workos-token';
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
  claim: (from: string, to: string) => Promise<number>;
  keys?: SigningKeys;
}

export async function requestOwner(req: IncomingMessage, keys: SigningKeys | undefined): Promise<string | null> {
  const signed = await signedIdentity(req);
  if (signed !== null) return signed;
  if (keys === undefined) return null;
  const session = await bearerSession(req, keys);
  return session?.organization ?? null;
}

async function walletOwner(req: IncomingMessage): Promise<string | null> {
  const header = req.headers['x-metro-wallet'];
  if (typeof header !== 'string' || header === '') return null;
  const proxy = { headers: { authorization: header }, method: req.method, url: req.url } as IncomingMessage;
  return signedIdentity(proxy);
}

type Known = { kind: 'index' } | { kind: 'claim' } | { kind: 'server'; id: string } | { kind: 'avatar'; id: string };
type Target = Known | { kind: 'unknown' } | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  return segments.length === 1 && segments[0] === 'claim' ? { kind: 'claim' } : idTarget(segments);
}

function idTarget(segments: string[]): Target {
  const id = parseId(segments[0] ?? '');
  if (id === null) return { kind: 'unknown' };
  if (segments.length === 1) return { kind: 'server', id };
  return segments.length === 2 && segments[1] === 'avatar' ? { kind: 'avatar', id } : { kind: 'unknown' };
}

const ALLOWED: Record<Known['kind'], string[]> = { index: ['GET', 'POST'], claim: ['POST'], server: ['PUT', 'DELETE'], avatar: ['PUT'] };

async function claim(req: IncomingMessage, deps: ServersApiDeps, owner: string): Promise<unknown> {
  const wallet = await walletOwner(req);
  if (wallet === null) throw new ApiError('a claim needs the wallet signature in x-metro-wallet', 400);
  const moved = await deps.claim(wallet, owner);
  log.info({ from: wallet, to: owner, moved }, 'servers-api: servers claimed by an organization');
  return { moved };
}

async function answer(req: IncomingMessage, deps: ServersApiDeps, owner: string, tgt: Known): Promise<unknown> {
  if (tgt.kind === 'claim') return claim(req, deps, owner);
  if (tgt.kind === 'index')
    return req.method === 'GET' ? { servers: await deps.list(owner) } : deps.add(owner, await readJsonBody(req));
  if (tgt.kind === 'avatar') return deps.avatar(owner, tgt.id, await readJsonBody(req, AVATAR_BODY_MAX));
  return req.method === 'DELETE' ? deps.remove(owner, tgt.id) : deps.rename(owner, tgt.id, await readJsonBody(req));
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServersApiDeps, tgt: Known): Promise<void> {
  try {
    const owner = await requestOwner(req, deps.keys);
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
