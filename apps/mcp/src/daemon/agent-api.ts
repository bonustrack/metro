import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { publicBaseUrl } from './attach-serve.js';
import {
  apiFailure,
  apiSession,
  cors,
  readJsonBody,
  sendJson,
  type ApiSession,
} from './api-http.js';
import {
  accountRoute,
  accountRouteAllows,
  ATTACHABLE,
  handleAccountRoute,
  type AccountApiDeps,
  type AccountRoute,
} from './account-api.js';
import {
  parseAgentId,
  type AgentSummary,
  type CreatedAgent,
  type DeletedAgent,
} from '../db/agent-admin.js';

const PREFIX = '/api/agents';
const DEFAULT_PUBLIC_BASE = 'https://mcp.metro.box';
const SERVER_NAME = 'metro';

export interface AgentApiDeps extends AccountApiDeps {
  listAgents: (email: string, granted: string[]) => Promise<AgentSummary[]>;
  createAgent: (email: string, name: string) => Promise<CreatedAgent>;
  deleteAgent: (
    email: string,
    granted: string[],
    id: number,
  ) => Promise<DeletedAgent>;
  gatherAccounts: (allowed: Set<number>) => Promise<Record<string, unknown[]>>;
  capabilities: () => Record<string, string[]>;
}

type Target =
  | { kind: 'collection' }
  | { kind: 'agent'; id: number }
  | { kind: 'accounts'; id: number; route: AccountRoute }
  | { kind: 'unknown' }
  | null;

function subTarget(id: number, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'agent', id };
  if (rest[0] !== 'accounts') return { kind: 'unknown' };
  const route = accountRoute(rest.slice(1));
  return route === null ? { kind: 'unknown' } : { kind: 'accounts', id, route };
}

export function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'collection' };
  const id = parseAgentId(head);
  return id === null ? { kind: 'unknown' } : subTarget(id, segments.slice(1));
}

export function mcpEndpoint(): string {
  return `${publicBaseUrl() ?? DEFAULT_PUBLIC_BASE}/mcp`;
}

export function mcpAddCommand(key: string): string {
  const url = `${mcpEndpoint()}?token=${key}`;
  return `claude mcp add --transport http ${SERVER_NAME} "${url}"`;
}

interface KeyPayload {
  key: string | null;
  endpoint: string | null;
  command: string | null;
}

function keyPayload(agent: AgentSummary): KeyPayload {
  const value = agent.owned ? agent.key : null;
  if (value === null) return { key: null, endpoint: null, command: null };
  return {
    key: value,
    endpoint: `${mcpEndpoint()}?token=${value}`,
    command: mcpAddCommand(value),
  };
}

function agentPayload(agent: AgentSummary): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    owned: agent.owned,
    ...keyPayload(agent),
  };
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
): Promise<void> {
  const list = await deps.listAgents(session.email, session.granted);
  const accounts = await deps.gatherAccounts(new Set(list.map((a) => a.id)));
  sendJson(req, res, 200, {
    email: session.email,
    endpoint: mcpEndpoint(),
    agents: list.map(agentPayload),
    accounts,
    capabilities: deps.capabilities(),
    attachable: ATTACHABLE,
  });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = (body as { name?: unknown }).name;
  const created = await deps.createAgent(session.email, name as string);
  log.info(
    { agent: created.name, id: created.id, owner: session.email },
    'agent-api: created agent',
  );
  sendJson(req, res, 201, {
    id: created.id,
    name: created.name,
    key: created.key,
    endpoint: `${mcpEndpoint()}?token=${created.key}`,
    command: mcpAddCommand(created.key),
  });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  id: number,
): Promise<void> {
  const gone = await deps.deleteAgent(session.email, session.granted, id);
  log.info(
    { agent: gone.name, id: gone.id, owner: session.email },
    'agent-api: deleted agent',
  );
  sendJson(req, res, 200, { id: gone.id, name: gone.name, deleted: true });
}

async function routeAgent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  id: number | null,
): Promise<void> {
  try {
    if (id !== null) await handleDelete(req, res, deps, session, id);
    else if (req.method === 'GET') await handleList(req, res, deps, session);
    else await handleCreate(req, res, deps, session);
  } catch (err) {
    apiFailure(req, res, err);
  }
}

const ALLOWED: Record<string, string[]> = {
  collection: ['GET', 'POST'],
  agent: ['DELETE'],
};

function methodAllowed(tgt: Target & object, method: string | undefined): boolean {
  if (tgt.kind === 'accounts') return accountRouteAllows(tgt.route, method);
  return (ALLOWED[tgt.kind] ?? []).includes(method ?? '');
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  tgt: Target & object,
): Promise<void> {
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return Promise.resolve();
  }
  if (tgt.kind === 'accounts')
    return handleAccountRoute(req, res, deps, session, tgt.id, tgt.route);
  return routeAgent(
    req,
    res,
    deps,
    session,
    tgt.kind === 'agent' ? tgt.id : null,
  );
}

export function handleAgentApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such agent' });
    return true;
  }
  if (!methodAllowed(tgt, req.method)) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  dispatch(req, res, deps, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'agent-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'agent api failed' });
  });
  return true;
}
