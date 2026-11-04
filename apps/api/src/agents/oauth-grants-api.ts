import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import type { Database } from '@metro-labs/connectors/db/database';
import { approveGrant, denyGrant, pendingGrant, type OauthGrantRow } from '@metro-labs/connectors/db/oauth-grants';
import { callerOf } from '../server-route.js';

const ROUTE = /^\/api\/oauth\/grants\/([^/]+)\/?$/;

export interface OauthGrantsDeps {
  keys: SigningKeys;
  db: () => Database;
  now: () => number;
}

interface GrantView {
  id: string;
  client: string;
  returnTo: string;
  expiresAt: number;
}

const gone = (): ApiError => new ApiError('This sign-in request is no longer open. Start again from the app.', 404);

function returnToOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host === '' ? url.protocol.replace(/:$/, '') : url.host;
  } catch {
    return '';
  }
}

const grantView = (row: OauthGrantRow): GrantView => ({ id: row.id, client: row.clientName, returnTo: returnToOf(row.redirectUri), expiresAt: row.expiresAt });

async function readGrant(deps: OauthGrantsDeps, id: string): Promise<{ grant: GrantView }> {
  const row = await pendingGrant(deps.db(), id, deps.now());
  if (row === null) throw gone();
  return { grant: grantView(row) };
}

async function answerGrant(deps: OauthGrantsDeps, session: Session, owner: string, id: string, body: unknown): Promise<{ redirect: string }> {
  const decision = isRecord(body) ? body.decision : undefined;
  if (decision === 'deny') {
    const redirect = await denyGrant(deps.db(), id, deps.now());
    log.info({ owner, grant: id, by: session.userId }, 'oauth: an app sign-in was declined');
    return { redirect };
  }
  if (decision !== 'allow') throw new ApiError('decision must be allow or deny', 400);
  if (session.role !== 'admin') throw new ApiError('Only an admin of the organization can connect an app to an agent.', 403);
  const agent = parseId(isRecord(body) && typeof body.agent === 'string' ? body.agent : '');
  if (agent === null) throw new ApiError('Choose the agent the app will use.', 400);
  const redirect = await approveGrant(deps.db(), { id, owner, agent, by: session.userId, now: deps.now() });
  log.info({ owner, agent, grant: id, by: session.userId }, 'oauth: an app sign-in was approved');
  return { redirect };
}

async function answer(req: IncomingMessage, deps: OauthGrantsDeps, id: string): Promise<unknown> {
  const { session, owner } = await callerOf(req, deps.keys);
  if (req.method === 'GET') return readGrant(deps, id);
  return answerGrant(deps, session, owner, id, await readJsonBody(req));
}

export function handleOauthGrantsRequest(req: IncomingMessage, res: ServerResponse, deps: OauthGrantsDeps): boolean {
  const found = ROUTE.exec((req.url ?? '').split('?')[0] ?? '');
  if (found === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const id = parseId(found[1] ?? '');
  if (id === null) {
    sendJson(req, res, 404, { error: gone().message });
    return true;
  }
  answer(req, deps, id)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'oauth-grants');
    });
  return true;
}
