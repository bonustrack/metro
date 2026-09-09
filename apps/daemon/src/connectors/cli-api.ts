import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { cors, sendJson, type AgentIdentity } from '@metro-labs/http/api-http';
import { publicBaseOrDefault } from '../files/attach-serve.js';
import { relayServersJson, type RelayServerEntry } from './json.js';
import { agentIdForKey } from '../agents/keys.js';

const PATH = '/api/cli/mcp';

export interface LocalCliDeps {
  agentName: (agentId: string) => string | null;
  connectorEntries: (agentId: string) => Promise<RelayServerEntry[]>;
}

function keyOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  return query.get('token')?.trim() ?? '';
}

export function keyIdentity(req: IncomingMessage): AgentIdentity | null {
  const key = keyOf(req);
  const agentId = key === '' ? undefined : agentIdForKey(key);
  return agentId === undefined ? null : { subject: 'agent-key', agentId };
}

export function handleLocalCliRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalCliDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH && !path.startsWith('/api/cli/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (path !== PATH) {
    sendJson(req, res, 404, { error: 'not on a local daemon' });
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const who = keyIdentity(req);
  if (who === null) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  deps
    .connectorEntries(who.agentId)
    .then((entries) => {
      const agent = deps.agentName(who.agentId) ?? '';
      sendJson(req, res, 200, { json: relayServersJson(entries, publicBaseOrDefault(), keyOf(req)), agent });
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'local cli: request failed');
      if (!res.headersSent) sendJson(req, res, 500, { error: 'cli failed' });
    });
  return true;
}
