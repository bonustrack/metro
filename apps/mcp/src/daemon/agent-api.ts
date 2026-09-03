import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { publicBaseOrDefault } from './attach-serve.js';
import {
  apiFailure,
  apiSession,
  projectParam,
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
  type ResetAgentKey,
} from '../db/agent-admin.js';

const PREFIX = '/api/agents';
const SERVER_NAME = 'metro';

export interface AgentApiDeps extends AccountApiDeps {
  listAgents: (subject: string, project: string) => Promise<AgentSummary[]>;
  createAgent: (
    subject: string,
    project: string,
    name: string,
  ) => Promise<CreatedAgent>;
  deleteAgent: (
    subject: string,
    id: string,
  ) => Promise<DeletedAgent>;
  resetKey: (
    subject: string,
    id: string,
  ) => Promise<ResetAgentKey>;
  gatherAccounts: (allowed: Set<string>) => Promise<{
    accounts: Record<string, unknown[]>;
    unavailable: string[];
  }>;
  capabilities: () => Record<string, string[]>;
  liveness: () => Map<string, { connected: boolean; lastSeenAt: number }>;
  releaseRuntime: (subject: string, agentId: string) => Promise<void>;
  runtimes: (agentIds: string[]) => Promise<Map<string, string>>;
  connectorIds: (agentIds: string[]) => Promise<Map<string, string[]>>;
}

type Routable =
  | { kind: 'collection' }
  | { kind: 'agent'; id: string }
  | { kind: 'key'; id: string }
  | { kind: 'runtime'; id: string }
  | { kind: 'accounts'; id: string; route: AccountRoute };

type Target = Routable | { kind: 'unknown' } | null;

function subTarget(id: string, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'agent', id };
  if (rest.length === 1 && rest[0] === 'key') return { kind: 'key', id };
  if (rest.length === 1 && rest[0] === 'runtime')
    return { kind: 'runtime', id };
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
  return `${publicBaseOrDefault()}/mcp`;
}

const LOCAL_MCP_ENDPOINT = 'http://127.0.0.1:8420/mcp';

export function mcpAddCommand(key: string): string {
  const url = `${LOCAL_MCP_ENDPOINT}?token=${key}`;
  return `claude mcp add --transport http ${SERVER_NAME} "${url}"`;
}

interface KeyPayload {
  key: string | null;
  endpoint: string | null;
  command: string | null;
}

function credentials(key: string): KeyPayload {
  return {
    key,
    endpoint: `${LOCAL_MCP_ENDPOINT}?token=${key}`,
    command: mcpAddCommand(key),
  };
}

function keyPayload(agent: AgentSummary): KeyPayload {
  const value = agent.owned ? agent.key : null;
  if (value === null) return { key: null, endpoint: null, command: null };
  return credentials(value);
}

function livenessPayload(
  agent: AgentSummary,
  live: Map<string, { connected: boolean; lastSeenAt: number }>,
): Record<string, unknown> {
  const found = agent.owned ? live.get(agent.id) : undefined;
  if (found === undefined) return { connected: false, last_seen: null };
  return {
    connected: found.connected,
    last_seen: new Date(found.lastSeenAt).toISOString(),
  };
}

function agentPayload(
  agent: AgentSummary,
  live: Map<string, { connected: boolean; lastSeenAt: number }>,
  runtimes: Map<string, string>,
  connectors: Map<string, string[]>,
): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    owned: agent.owned,
    runtime: agent.owned ? (runtimes.get(agent.id) ?? null) : null,
    connector_ids: connectors.get(agent.id) ?? [],
    ...livenessPayload(agent, live),
    ...keyPayload(agent),
  };
}

function wantsAccounts(req: IncomingMessage): boolean {
  const query = (req.url ?? '').split('?')[1] ?? '';
  return new URLSearchParams(query).get('accounts') === '1';
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
): Promise<void> {
  const project = projectParam(req);
  if (project === null) {
    sendJson(req, res, 400, { error: 'a project is required' });
    return;
  }
  const list = await deps.listAgents(session.subject, project);
  const live = deps.liveness();
  const held = await deps.runtimes(
    list.filter((a) => a.owned).map((a) => a.id),
  );
  const connectors = await deps.connectorIds(list.map((a) => a.id));
  const base = {
    subject: session.subject,
    endpoint: mcpEndpoint(),
    agents: list.map((a) => agentPayload(a, live, held, connectors)),
    capabilities: deps.capabilities(),
    attachable: ATTACHABLE,
  };
  if (!wantsAccounts(req)) {
    sendJson(req, res, 200, base);
    return;
  }
  const { accounts, unavailable } = await deps.gatherAccounts(
    new Set(list.map((a) => a.id)),
  );
  sendJson(req, res, 200, { ...base, accounts, unavailable });
}

async function handleRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  await deps.releaseRuntime(session.subject, id);
  log.info({ agent: id }, 'agent-api: runtime released');
  sendJson(req, res, 200, { agent: id, runtime: null });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = (body as { name?: unknown }).name;
  const project = projectParam(req);
  if (project === null) {
    sendJson(req, res, 400, { error: 'a project is required' });
    return;
  }
  const created = await deps.createAgent(session.subject, project, name as string);
  log.info(
    { agent: created.name, id: created.id, owner: session.subject },
    'agent-api: created agent',
  );
  sendJson(req, res, 201, {
    id: created.id,
    name: created.name,
    ...credentials(created.key),
  });
}

async function handleResetKey(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const reset = await deps.resetKey(session.subject, id);
  log.info(
    { agent: reset.name, id: reset.id, owner: session.subject },
    'agent-api: reset agent key',
  );
  sendJson(req, res, 200, {
    id: reset.id,
    name: reset.name,
    reset: true,
    ...credentials(reset.key),
  });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const gone = await deps.deleteAgent(session.subject, id);
  log.info(
    { agent: gone.name, id: gone.id, owner: session.subject },
    'agent-api: deleted agent',
  );
  sendJson(req, res, 200, { id: gone.id, name: gone.name, deleted: true });
}

type AgentTarget = Exclude<Routable, { kind: 'accounts' }>;

async function routeAgent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  tgt: AgentTarget,
): Promise<void> {
  try {
    if (tgt.kind === 'key') await handleResetKey(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'runtime')
      await handleRuntime(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'agent')
      await handleDelete(req, res, deps, session, tgt.id);
    else if (req.method === 'GET') await handleList(req, res, deps, session);
    else await handleCreate(req, res, deps, session);
  } catch (err) {
    apiFailure(req, res, err);
  }
}

const ALLOWED: Record<AgentTarget['kind'], string[]> = {
  collection: ['GET', 'POST'],
  agent: ['DELETE'],
  key: ['POST'],
  runtime: ['DELETE'],
};

function methodAllowed(tgt: Routable, method: string | undefined): boolean {
  if (tgt.kind === 'accounts') return accountRouteAllows(tgt.route, method);
  return ALLOWED[tgt.kind].includes(method ?? '');
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  tgt: Routable,
): Promise<void> {
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return Promise.resolve();
  }
  if (tgt.kind === 'accounts')
    return handleAccountRoute(req, res, deps, session, tgt.id, tgt.route);
  return routeAgent(req, res, deps, session, tgt);
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
