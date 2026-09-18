import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, bodyField, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { resetIdentities } from '@metro-labs/http/identity-registry';
import { isOrganizationId } from '@metro-labs/http/workos-token';

const PATH = '/api/owner';

export interface OwnerRouteDeps {
  owner: () => string | null;
  setOwner: (owner: string) => string;
}

async function claim(req: IncomingMessage, deps: OwnerRouteDeps): Promise<{ owner: string; previous: string }> {
  const session = await apiSession(req);
  if (session === null) throw new ApiError('unauthorized', 401);
  const previous = deps.owner();
  if (previous === null) throw new ApiError('this machine has no owner yet', 403);
  if (isOrganizationId(previous)) throw new ApiError('this machine already belongs to an organization', 409);
  if (session.subject !== previous) throw new ApiError('only the wallet that owns this machine can hand it to an organization', 403);
  const wanted = bodyField(await readJsonBody(req), 'owner');
  if (typeof wanted !== 'string' || !isOrganizationId(wanted.trim())) throw new ApiError('owner must be an organization id (org_…)', 400);
  const owner = deps.setOwner(wanted.trim());
  resetIdentities();
  log.info({ previous, owner }, 'owner: this machine now belongs to an organization; the wallet is no longer accepted');
  return { owner, previous };
}

export function handleOwnerRequest(req: IncomingMessage, res: ServerResponse, deps: OwnerRouteDeps): boolean {
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
  claim(req, deps)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'owner');
    });
  return true;
}
