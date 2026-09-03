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
import type { AgentConnectors } from '../db/agent-connectors.js';

const PREFIX = '/api/agents';

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
  mintCode: (
    subject: string,
    agentId: string,
  ) => Promise<{ code: string; expiresAt: number; agent: string }>;
}

type Routable =
  | { kind: 'connectors'; id: string }
  | { kind: 'connector'; id: string; connectorId: string }
  | { kind: 'code'; id: string };

type Target = Routable | { kind: 'unknown' } | null;

const ALLOWED: Record<Routable['kind'], string[]> = {
  connectors: ['GET', 'POST'],
  connector: ['DELETE'],
  code: ['POST'],
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
  if (head === 'code' && segments.length === 2) return { kind: 'code', id };
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

async function handleCode(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const minted = await deps.mintCode(session.subject, id);
  log.info({ agent: id, subject: session.subject }, 'agent-api: minted pairing code');
  sendJson(req, res, 201, minted);
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
    else if (tgt.kind === 'code') await handleCode(req, res, deps, session, tgt.id);
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
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  route(req, res, deps, session, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'agent-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'agent api failed' });
  });
  return true;
}
