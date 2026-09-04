import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { apiFailure, apiSession, cors, readJsonBody, sendJson, type ApiSession } from './api-http.js';
import { parseId } from '../db/ids.js';
import { ENVELOPE_MAX, type VaultBundle, type VaultEntry } from '../db/vault.js';

const PREFIX = '/api/vault';
const BODY_MAX = ENVELOPE_MAX + 64 * 1024;

export interface VaultApiDeps {
  list: (subject: string) => Promise<VaultEntry[]>;
  put: (subject: string, id: string, body: unknown) => Promise<VaultEntry>;
  get: (subject: string, id: string) => Promise<VaultBundle>;
  remove: (subject: string, id: string) => Promise<{ id: string; name: string }>;
}

type Target = { kind: 'index' } | { kind: 'bundle'; id: string } | { kind: 'unknown' } | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = parseId(segments[0] ?? '');
  return id === null || segments.length !== 1 ? { kind: 'unknown' } : { kind: 'bundle', id };
}

const ALLOWED: Record<'index' | 'bundle', string[]> = { index: ['GET'], bundle: ['GET', 'PUT', 'DELETE'] };

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VaultApiDeps,
  session: ApiSession,
  tgt: { kind: 'index' } | { kind: 'bundle'; id: string },
): Promise<void> {
  try {
    if (tgt.kind === 'index') {
      sendJson(req, res, 200, { entries: await deps.list(session.subject) });
      return;
    }
    if (req.method === 'GET') sendJson(req, res, 200, await deps.get(session.subject, tgt.id));
    else if (req.method === 'DELETE') sendJson(req, res, 200, await deps.remove(session.subject, tgt.id));
    else {
      const saved = await deps.put(session.subject, tgt.id, await readJsonBody(req, BODY_MAX));
      log.info({ id: saved.id, name: saved.name }, 'vault-api: bundle stored');
      sendJson(req, res, 200, saved);
    }
  } catch (err) {
    apiFailure(req, res, err, 'vault-api');
  }
}

export function handleVaultApiRequest(req: IncomingMessage, res: ServerResponse, deps: VaultApiDeps): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such bundle' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  route(req, res, deps, session, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'vault-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'vault api failed' });
  });
  return true;
}
