import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type SigningKeys } from '@metro-labs/http/workos-token';
import { completeSignIn, createConnector, startSignIn, viewOf, type Caller } from './actions.js';
import type { McpCallStore } from '@metro-labs/connectors/db/mcp-calls';
import { connectorActivity } from './activity.js';
import { connectorActivityStats } from './activity-stats.js';
import { assignConnector, deleteConnector, listConnectors, unassignConnector, updateConnector, updateConnectorAgentPolicy } from './manage.js';
import { listConnectorTools } from '@metro-labs/connectors/catalogue';
import { callbackLocation } from './sign-in.js';
import { copyConnector, type CopyDeps } from './copy.js';

const PREFIX = '/api/connectors';
const BODY_MAX = 1024 * 1024;

export interface ConnectorsApiDeps extends CopyDeps {
  keys: SigningKeys;
  calls: McpCallStore;
}

type Target =
  | { kind: 'collection' }
  | { kind: 'activity' }
  | { kind: 'activity-stats' }
  | { kind: 'callback' }
  | { kind: 'complete' }
  | { kind: 'connector'; id: string }
  | { kind: 'sign-in' | 'copy'; id: string }
  | { kind: 'tools'; id: string }
  | { kind: 'agent' | 'agent-policy'; id: string; agent: string };

const METHODS: Record<Target['kind'], string[]> = {
  collection: ['GET', 'POST'],
  activity: ['GET'],
  'activity-stats': ['GET'],
  tools: ['GET'],
  callback: ['GET'],
  complete: ['POST'],
  connector: ['GET', 'PUT', 'DELETE'],
  'sign-in': ['POST'],
  copy: ['POST'],
  agent: ['PUT', 'DELETE'],
  'agent-policy': ['PUT'],
};

const NAMED: Record<string, Target> = {
  callback: { kind: 'callback' },
  complete: { kind: 'complete' },
  activity: { kind: 'activity' },
  'activity/stats': { kind: 'activity-stats' },
};

const NAMED_HEADS = new Set(Object.keys(NAMED).map((name) => name.split('/')[0]));

function byAgent(id: string, rest: string[]): Target | 'unknown' {
  const agent = parseId(rest[1] ?? '');
  if (rest[0] !== 'agents' || agent === null) return 'unknown';
  if (rest.length === 2) return { kind: 'agent', id, agent };
  return rest.length === 3 && rest[2] === 'policy' ? { kind: 'agent-policy', id, agent } : 'unknown';
}

function byId(id: string, rest: string[]): Target | 'unknown' {
  if (rest.length === 0) return { kind: 'connector', id };
  if (rest.length === 1 && rest[0] === 'sign-in') return { kind: 'sign-in', id };
  if (rest.length === 1 && rest[0] === 'tools') return { kind: 'tools', id };
  if (rest.length === 1 && rest[0] === 'copy') return { kind: 'copy', id };
  return byAgent(id, rest);
}

function targetOf(path: string): Target | 'unknown' | null {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const parts = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const [head = '', ...rest] = parts;
  if (NAMED_HEADS.has(head)) return NAMED[parts.join('/')] ?? 'unknown';
  const id = parseId(head);
  return id === null ? 'unknown' : byId(id, rest);
}

function admin(caller: Caller): void {
  if (caller.session.role !== 'admin') throw new ApiError('managing connectors needs the admin role in your organization', 403);
}

async function callerOf(req: IncomingMessage, deps: ConnectorsApiDeps): Promise<Caller> {
  const session = await bearerSession(req, deps.keys);
  const owner = session?.organization ?? null;
  if (session === null || owner === null) throw new ApiError('unauthorized', 401);
  return { session, owner };
}

interface Context {
  deps: ConnectorsApiDeps;
  caller: Caller;
  body: unknown;
  query: URLSearchParams;
  id: string;
  agent: string;
}

const ROUTES: Record<string, (c: Context) => Promise<unknown>> = {
  'GET collection': async (c) => ({ connectors: await listConnectors(c.deps, c.caller.owner), admin: c.caller.session.role === 'admin' }),
  'POST collection': (c) => createConnector(c.deps, c.caller, c.body),
  'GET activity': (c) => connectorActivity(c.deps.calls, c.caller.owner, c.query),
  'GET activity-stats': (c) => connectorActivityStats(c.deps.calls, c.caller.owner, c.query, c.deps.now()),
  'GET tools': (c) => listConnectorTools(c.deps, c.caller.owner, c.id),
  'POST complete': (c) => completeSignIn(c.deps, c.caller, c.body),
  'GET connector': (c) => viewOf(c.deps, c.caller.owner, c.id),
  'PUT connector': (c) => updateConnector(c.deps, c.caller, c.id, c.body),
  'DELETE connector': (c) => deleteConnector(c.deps, c.caller, c.id),
  'POST sign-in': (c) => startSignIn(c.deps, c.caller, c.id, c.body),
  'POST copy': (c) => copyConnector(c.deps, c.caller, c.id, c.body),
  'PUT agent': (c) => assignConnector(c.deps, c.caller, c.id, c.agent, c.body),
  'PUT agent-policy': (c) => updateConnectorAgentPolicy(c.deps, c.caller, c.id, c.agent, c.body),
  'DELETE agent': (c) => unassignConnector(c.deps, c.caller, c.id, c.agent),
};

const MEMBER_READS = new Set(['GET collection', 'GET activity', 'GET activity-stats', 'GET connector', 'GET tools']);

async function answer(req: IncomingMessage, deps: ConnectorsApiDeps, target: Exclude<Target, { kind: 'callback' }>): Promise<unknown> {
  const caller = await callerOf(req, deps);
  const method = req.method ?? 'GET';
  const route = `${method} ${target.kind}`;
  if (!MEMBER_READS.has(route)) admin(caller);
  const handler = ROUTES[route];
  if (handler === undefined) throw new ApiError('method not allowed', 405);
  const body = method === 'GET' || method === 'DELETE' ? {} : await readJsonBody(req, BODY_MAX);
  const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  return handler({ deps, caller, body, query, id: 'id' in target ? target.id : '', agent: 'agent' in target ? target.agent : '' });
}

function callback(req: IncomingMessage, res: ServerResponse, deps: ConnectorsApiDeps): void {
  try {
    const location = callbackLocation(deps, new URLSearchParams((req.url ?? '').split('?')[1] ?? ''));
    res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'org-connectors: a sign-in came back that Metro could not use');
    apiFailure(req, res, err, 'org-connectors');
  }
}

export function handleConnectorsApiRequest(req: IncomingMessage, res: ServerResponse, deps: ConnectorsApiDeps): boolean {
  const target = targetOf((req.url ?? '').split('?')[0] ?? '');
  if (target === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (target === 'unknown') {
    sendJson(req, res, 404, { error: 'not found' });
    return true;
  }
  if (!METHODS[target.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  if (target.kind === 'callback') {
    callback(req, res, deps);
    return true;
  }
  answer(req, deps, target)
    .then((body) => {
      sendJson(req, res, (target.kind === 'collection' || target.kind === 'copy') && req.method === 'POST' ? 201 : 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'org-connectors');
    });
  return true;
}
