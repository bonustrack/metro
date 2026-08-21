import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiSession, cors, sendJson } from './api-http.js';

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
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  sendJson(req, res, 200, { email: session.email });
  return true;
}
