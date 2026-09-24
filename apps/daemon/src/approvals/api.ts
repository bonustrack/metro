import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, bodyField, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { decideApproval, type Decision } from './flow.js';
import { listApprovals, type ApprovalRecord } from './store.js';

const PREFIX = '/api/approvals';
const ID_RE = /^[a-km-z]{5}$/;

export function approvalView(rec: ApprovalRecord): Record<string, unknown> {
  const shown: Record<string, unknown> = { ...rec };
  delete shown.args;
  return shown;
}

function decisionOf(body: unknown): Decision {
  const value = bodyField(body, 'decision');
  if (value !== 'approve' && value !== 'reject') throw new ApiError("decision is 'approve' or 'reject'", 400);
  return value;
}

async function answer(req: IncomingMessage, id: string | undefined, subject: string): Promise<unknown> {
  if (id === undefined) {
    if (req.method !== 'GET') throw new ApiError('method not allowed', 405);
    return { approvals: listApprovals().map(approvalView) };
  }
  if (req.method !== 'POST') throw new ApiError('method not allowed', 405);
  if (!ID_RE.test(id)) throw new ApiError('no such approval', 404);
  const decision = decisionOf(await readJsonBody(req));
  const rec = await decideApproval(id, decision, `page ${subject}`);
  if (rec === undefined) throw new ApiError('no such approval', 404);
  return { approval: approvalView(rec) };
}

export function handleApprovalsRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  const rest = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  if (rest.length > 1) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      sendJson(req, res, 200, await answer(req, rest[0], session.subject));
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'approvals-api');
    });
  return true;
}
