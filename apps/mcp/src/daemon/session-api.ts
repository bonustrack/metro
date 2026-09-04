import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiFailure, apiSession, cors, sendJson } from './api-http.js';

const PATH = '/api/session';

export function handleSessionApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then((session) => {
      if (!session) sendJson(req, res, 401, { error: 'unauthorized' });
      else sendJson(req, res, 200, { subject: session.subject });
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'session');
    });
  return true;
}
