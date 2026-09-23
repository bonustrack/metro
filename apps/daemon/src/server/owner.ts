import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, readJsonBody, requireAdmin, sendJson } from '@metro-labs/http/api-http';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';

const PATH = '/api/owner';

export interface OwnerApiDeps {
  setOwner: (owner: string) => string;
}

async function move(req: IncomingMessage, deps: OwnerApiDeps): Promise<{ owner: string }> {
  const session = await apiSession(req);
  if (!session) throw new ApiError('unauthorized', 401);
  requireAdmin(session);
  const body = await readJsonBody(req);
  const owner = isRecord(body) && typeof body.owner === 'string' ? body.owner.trim() : '';
  if (!isOrganizationId(owner)) throw new ApiError('owner must be an organization id', 400);
  if (owner === session.subject) throw new ApiError('this machine already belongs to that organization', 409);
  const saved = deps.setOwner(owner);
  log.info({ from: session.subject, to: saved }, 'owner: this machine moved to another organization');
  return { owner: saved };
}

export function handleOwnerRequest(req: IncomingMessage, res: ServerResponse, deps: OwnerApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  move(req, deps)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'owner-api');
    });
  return true;
}
