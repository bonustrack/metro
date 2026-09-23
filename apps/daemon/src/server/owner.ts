import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody, sessionRoute, type ApiSession } from '@metro-labs/http/api-http';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';

const PATH = '/api/owner';

export interface OwnerApiDeps {
  setOwner: (owner: string) => string;
}

async function move(req: IncomingMessage, session: ApiSession, deps: OwnerApiDeps): Promise<{ owner: string }> {
  const body = await readJsonBody(req);
  const owner = isRecord(body) && typeof body.owner === 'string' ? body.owner.trim() : '';
  if (!isOrganizationId(owner)) throw new ApiError('owner must be an organization id', 400);
  if (owner === session.subject) throw new ApiError('this machine already belongs to that organization', 409);
  const saved = deps.setOwner(owner);
  log.info({ from: session.subject, to: saved }, 'owner: this machine moved to another organization');
  return { owner: saved };
}

export function handleOwnerRequest(req: IncomingMessage, res: ServerResponse, deps: OwnerApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['POST'] }, admin: true, label: 'owner-api' }, (session) => move(req, session, deps));
}
