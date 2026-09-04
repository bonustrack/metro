import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { cors, sendJson, type AgentIdentity } from './api-http.js';
import { publicBaseOrDefault } from './attach-serve.js';
import { relayServersJson, type RelayServerEntry } from './connector-json.js';
import { agentIdForKey } from '../db/key-map.js';
import type { ConnectorSummary } from '../db/connectors.js';

const PREFIX = '/api/cli';

export interface LocalCliDeps {
  agentName: (agentId: string) => string | null;
  connectorEntries: (agentId: string) => Promise<RelayServerEntry[]>;
  connectorSummaries: (agentId: string) => Promise<ConnectorSummary[]>;
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

async function answer(path: string, key: string, agentId: string, deps: LocalCliDeps): Promise<unknown> {
  const agent = deps.agentName(agentId) ?? '';
  if (path === `${PREFIX}/session`) return { subject: 'this machine', agent };
  if (path === `${PREFIX}/connectors`) return { agent, connectors: await deps.connectorSummaries(agentId) };
  return { json: relayServersJson(await deps.connectorEntries(agentId), publicBaseOrDefault(), key), agent };
}

export function handleLocalCliRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalCliDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (![`${PREFIX}/mcp`, `${PREFIX}/session`, `${PREFIX}/connectors`].includes(path)) {
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
  answer(path, keyOf(req), who.agentId, deps)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'local cli: request failed');
      if (!res.headersSent) sendJson(req, res, 500, { error: 'cli failed' });
    });
  return true;
}
