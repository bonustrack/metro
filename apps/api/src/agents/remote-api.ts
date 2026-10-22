import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import { agentApprovals, agentTokens, answerAgentApproval, dropAgentToken, newAgentToken, type RemoteDeps } from './remote.js';

const ROUTE = /^\/api\/agents\/([^/]+)\/(tokens|approvals)(?:\/([^/]+))?\/?$/;

export interface RemoteAgentsApiDeps extends RemoteDeps {
  keys: SigningKeys;
}

interface Target {
  agent: string;
  section: 'tokens' | 'approvals';
  item: string | null;
}

const ALLOWED: Record<string, string[]> = {
  'tokens:list': ['GET', 'POST'],
  'tokens:item': ['DELETE'],
  'approvals:list': ['GET'],
  'approvals:item': ['POST'],
};

function targetOf(path: string): Target | 'unknown' | null {
  const found = ROUTE.exec(path);
  if (found === null) return null;
  const agent = parseId(found[1] ?? '');
  if (agent === null) return 'unknown';
  return { agent, section: found[2] === 'tokens' ? 'tokens' : 'approvals', item: found[3] ?? null };
}

const routeKey = (target: Target): string => `${target.section}:${target.item === null ? 'list' : 'item'}`;

async function sessionOf(req: IncomingMessage, deps: RemoteAgentsApiDeps): Promise<{ session: Session; owner: string }> {
  const session = await bearerSession(req, deps.keys);
  const owner = session?.organization ?? null;
  if (session === null || owner === null) throw new ApiError('unauthorized', 401);
  return { session, owner };
}

function admin(session: Session): void {
  if (session.role !== 'admin') throw new ApiError('this needs the admin role in your organization', 403);
}

async function answer(req: IncomingMessage, deps: RemoteAgentsApiDeps, target: Target): Promise<unknown> {
  const { session, owner } = await sessionOf(req, deps);
  const method = req.method ?? 'GET';
  if (method === 'GET') return target.section === 'tokens' ? agentTokens(deps, owner, target.agent) : agentApprovals(deps, owner, target.agent);
  if (target.section === 'approvals') return answerAgentApproval(deps, session, owner, target.agent, target.item ?? '', await readJsonBody(req));
  admin(session);
  if (method === 'POST') return newAgentToken(deps, session, owner, target.agent, await readJsonBody(req));
  const id = parseId(target.item ?? '');
  if (id === null) throw new ApiError('no such access key', 404);
  return dropAgentToken(deps, session, owner, target.agent, id);
}

export function handleRemoteAgentsRequest(req: IncomingMessage, res: ServerResponse, deps: RemoteAgentsApiDeps): boolean {
  const target = targetOf((req.url ?? '').split('?')[0] ?? '');
  if (target === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (target === 'unknown') {
    sendJson(req, res, 404, { error: 'no such agent' });
    return true;
  }
  if (!(ALLOWED[routeKey(target)] ?? []).includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  answer(req, deps, target)
    .then((body) => {
      sendJson(req, res, req.method === 'POST' && target.section === 'tokens' ? 201 : 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'remote-agents');
    });
  return true;
}
