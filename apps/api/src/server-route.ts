import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';

export interface ServerRoute {
  path: RegExp;
  label: string;
  keys: SigningKeys;
  read: (owner: string, id: string) => Promise<unknown>;
  write: (session: Session, owner: string, id: string, body: unknown) => Promise<unknown>;
  refused?: (id: string, err: unknown) => void;
}

async function answer(req: IncomingMessage, res: ServerResponse, route: ServerRoute, id: string): Promise<void> {
  try {
    const session = await bearerSession(req, route.keys);
    const owner = session?.organization ?? null;
    if (session === null || owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    const body = req.method === 'GET' ? await route.read(owner, id) : await route.write(session, owner, id, await readJsonBody(req));
    sendJson(req, res, 200, body);
  } catch (err) {
    route.refused?.(id, err);
    apiFailure(req, res, err, route.label);
  }
}

export function handleServerRoute(req: IncomingMessage, res: ServerResponse, route: ServerRoute): boolean {
  const match = route.path.exec((req.url ?? '').split('?')[0] ?? '');
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
  answer(req, res, route, id).catch((err: unknown) => {
    apiFailure(req, res, err, route.label);
  });
  return true;
}
