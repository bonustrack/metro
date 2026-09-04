import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import {
  apiFailure,
  apiSession,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
  type ApiSession,
} from './api-http.js';
import { parseId } from '../db/ids.js';

const PREFIX = '/api/agents';

export interface AgentConnectors {
  id: string;
  name: string;
  connectorIds: string[];
}

export interface AgentConnectorApiDeps {
  agentConnectors: (subject: string, agentId: string) => Promise<AgentConnectors>;
  addConnector: (
    subject: string,
    agentId: string,
    connectorId: string,
  ) => Promise<AgentConnectors>;
  removeConnector: (
    subject: string,
    agentId: string,
    connectorId: string,
  ) => Promise<AgentConnectors>;
}

type Routable =
  | { kind: 'connectors'; id: string }
  | { kind: 'connector'; id: string; connectorId: string };

type Target = Routable | { kind: 'unknown' } | null;

const ALLOWED: Record<Routable['kind'], string[]> = {
  connectors: ['GET', 'POST'],
  connector: ['DELETE'],
};

function connectorTarget(id: string, rest: string[]): Target {
  if (rest.length === 1) return { kind: 'connectors', id };
  if (rest.length > 2) return { kind: 'unknown' };
  const connectorId = parseId(rest[1] ?? '');
  return connectorId === null
    ? { kind: 'unknown' }
    : { kind: 'connector', id, connectorId };
}

export function target(path: string): Target {
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = parseId(segments[0] ?? '');
  const head = segments[1];
  if (id === null || head === undefined) return null;
  if (head === 'connectors') return connectorTarget(id, segments.slice(1));
  return null;
}

async function handleConnectors(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(req, res, 200, await deps.agentConnectors(session.subject, id));
    return;
  }
  const connectorId = bodyField(await readJsonBody(req), 'connectorId');
  if (typeof connectorId !== 'string' || parseId(connectorId) === null) {
    sendJson(req, res, 400, { error: 'connectorId is required' });
    return;
  }
  sendJson(req, res, 200, await deps.addConnector(session.subject, id, connectorId));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentConnectorApiDeps,
  session: ApiSession,
  tgt: Routable,
): Promise<void> {
  try {
    if (tgt.kind === 'connectors') await handleConnectors(req, res, deps, session, tgt.id);
    else
      sendJson(
        req,
        res,
        200,
        await deps.removeConnector(session.subject, tgt.id, tgt.connectorId),
      );
  } catch (err) {
    apiFailure(req, res, err, 'agent-api');
  }
}

export function handleAgentConnectorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentConnectorApiDeps,
): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such connector' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then((session) => {
      if (!session) {
        sendJson(req, res, 401, { error: 'unauthorized' });
        return;
      }
      return route(req, res, deps, session, tgt);
    })
    .catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'agent-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'agent api failed' });
  });
  return true;
}
