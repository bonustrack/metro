import type { IncomingMessage, ServerResponse } from 'node:http';
import { cors, sendJson } from './api-http.js';

const PATH = '/api/mode';

export type DaemonMode = 'hosted' | 'linked' | 'local';

export interface ModeInfo {
  mode: DaemonMode;
  owner: string | null;
  project: string | null;
  version: string;
}

export function handleModeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  info: () => ModeInfo,
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
  sendJson(req, res, 200, info());
  return true;
}
