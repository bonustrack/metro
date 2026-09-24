import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, bodyField, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { answerPrompt, pendingPrompts, type Behavior, type PendingPrompt } from './pending.js';

const PREFIX = '/api/approvals';
const ID_RE = /^[a-km-z]{5}$/;

const approvalView = (p: PendingPrompt): Record<string, unknown> => ({
  id: p.requestId,
  tool: p.tool,
  description: p.description,
  preview: p.preview,
  line: p.line ?? null,
  requestedAt: new Date(p.at).toISOString(),
});

function decisionOf(body: unknown): Behavior {
  const value = bodyField(body, 'decision');
  if (value !== 'allow' && value !== 'deny') throw new ApiError("decision is 'allow' or 'deny'", 400);
  return value;
}

async function answer(req: IncomingMessage, id: string | undefined, subject: string): Promise<unknown> {
  if (id === undefined) {
    if (req.method !== 'GET') throw new ApiError('method not allowed', 405);
    return { approvals: pendingPrompts().map(approvalView) };
  }
  if (req.method !== 'POST') throw new ApiError('method not allowed', 405);
  if (!ID_RE.test(id)) throw new ApiError('no such approval', 404);
  const decision = decisionOf(await readJsonBody(req));
  const answered = await answerPrompt(id, decision, 'page', subject);
  if (answered === undefined) throw new ApiError('no such approval', 404);
  return { approval: approvalView(answered), decision };
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
