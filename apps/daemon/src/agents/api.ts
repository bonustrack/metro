import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import {
  apiFailure,
  apiSession,
  cors,
  sendJson,
} from '@metro-labs/http/api-http';
import { ATTACHABLE, handleAccountRoute, type AccountApiDeps } from './accounts-api.js';
import {
  accountRoute,
  accountRouteAllows,
  type AccountRoute,
} from './account-routes.js';
import type { AgentSummary } from './admin.js';

const PREFIX = '/api/agents';

export interface AgentApiDeps extends AccountApiDeps {
  listAgents: () => Promise<AgentSummary[]>;
  gatherAccounts: (allowed: Set<string>) => Promise<{
    accounts: Record<string, unknown[]>;
    unavailable: string[];
  }>;
  capabilities: () => Record<string, string[]>;
  attachable?: string[];
  connectorIds: (agentIds: string[]) => Promise<Map<string, string[]>>;
}

type Routable =
  | { kind: 'collection' }
  | { kind: 'accounts'; id: string; route: AccountRoute };

type Target = Routable | { kind: 'unknown' } | null;

function subTarget(id: string, rest: string[]): Target {
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
  const id = parseId(head);
  return id === null ? { kind: 'unknown' } : subTarget(id, segments.slice(1));
}

function agentPayload(agent: AgentSummary, connectors: Map<string, string[]>): Record<string, unknown> {
  return { id: agent.id, name: agent.name, connector_ids: connectors.get(agent.id) ?? [] };
}

function wantsAccounts(req: IncomingMessage): boolean {
  const query = (req.url ?? '').split('?')[1] ?? '';
  return new URLSearchParams(query).get('accounts') === '1';
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
): Promise<void> {
  const list = await deps.listAgents();
  const connectors = await deps.connectorIds(list.map((a) => a.id));
  const base = {
    agents: list.map((a) => agentPayload(a, connectors)),
    capabilities: deps.capabilities(),
    attachable: deps.attachable ?? ATTACHABLE,
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

const ALLOWED_LIST = ['GET'];

function methodAllowed(tgt: Routable, method: string | undefined): boolean {
  if (tgt.kind === 'accounts') return accountRouteAllows(tgt.route, method);
  return ALLOWED_LIST.includes(method ?? '');
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  tgt: Routable,
): Promise<void> {
  const session = await apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  if (tgt.kind === 'accounts') await handleAccountRoute(req, res, deps, tgt.id, tgt.route);
  else await handleList(req, res, deps);
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
    if (res.headersSent) return;
    apiFailure(req, res, err, 'agent-api');
  });
  return true;
}
