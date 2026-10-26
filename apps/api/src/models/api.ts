import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { beginCodexLogin, finishCodexLogin } from './codex-login.js';
import { beginDevice, pollDevice } from './codex-device.js';
import type { Caller, ModelsDeps } from './deps.js';
import { listConnectionModels } from './lists.js';
import { createModel, deleteModel, deleteRoute, listModels, patchModel, putRoute } from './manage.js';
import { beginOpenRouter, openRouterCallback } from './openrouter-login.js';
import { modelUsage, modelWindows } from './usage.js';
import { callerOf } from '../server-route.js';

const PREFIX = '/api/models';
const BODY_MAX = 64 * 1024;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

type Kind = 'collection' | 'usage' | 'windows' | 'route' | 'codex-login' | 'codex-callback' | 'codex-device' | 'codex-poll' | 'openrouter-login' | 'openrouter-callback' | 'connection' | 'models';

interface Target {
  kind: Kind;
  id: string;
}

const METHODS: Record<Kind, string[]> = {
  collection: ['GET', 'POST'],
  usage: ['GET'],
  windows: ['GET'],
  route: ['PUT', 'DELETE'],
  'codex-login': ['POST'],
  'codex-callback': ['POST'],
  'codex-device': ['POST'],
  'codex-poll': ['GET'],
  'openrouter-login': ['POST'],
  'openrouter-callback': ['GET'],
  connection: ['PATCH', 'DELETE'],
  models: ['GET'],
};

const NAMED: Record<string, Kind> = {
  usage: 'usage',
  windows: 'windows',
  route: 'route',
  'codex/login': 'codex-login',
  'codex/callback': 'codex-callback',
  'codex/device': 'codex-device',
  'openrouter/login': 'openrouter-login',
  'openrouter/callback': 'openrouter-callback',
};

const MEMBER_READS = new Set(['GET collection', 'GET models', 'GET usage', 'GET windows']);

const CALLBACK_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

function devicePoll(rest: string[]): Target | null {
  const [first, second, ticket = ''] = rest;
  return rest.length === 3 && first === 'codex' && second === 'device' && TICKET_RE.test(ticket) ? { kind: 'codex-poll', id: ticket } : null;
}

function byId(rest: string[]): Target | 'unknown' {
  const poll = devicePoll(rest);
  if (poll !== null) return poll;
  const id = parseId(rest[0]);
  if (id === null) return 'unknown';
  if (rest.length === 1) return { kind: 'connection', id };
  return rest.length === 2 && rest[1] === 'models' ? { kind: 'models', id } : 'unknown';
}

function targetOf(path: string): Target | 'unknown' | null {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection', id: '' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const rest = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const named = NAMED[rest.join('/')];
  return named === undefined ? byId(rest) : { kind: named, id: '' };
}

interface Context {
  deps: ModelsDeps;
  caller: Caller;
  body: unknown;
  id: string;
  query: URLSearchParams;
}

const ROUTES: Record<string, (c: Context) => Promise<unknown>> = {
  'GET collection': (c) => listModels(c.deps, c.caller.owner),
  'GET usage': (c) => modelUsage(c.deps.usage, c.caller.owner, c.query, c.deps.now()),
  'GET windows': (c) => modelWindows(c.deps.usage, c.caller.owner),
  'POST collection': (c) => createModel(c.deps, c.caller, c.body),
  'PUT route': (c) => putRoute(c.deps, c.caller, c.body),
  'DELETE route': (c) => deleteRoute(c.deps, c.caller, c.query),
  'POST codex-login': (c) => beginCodexLogin(c.deps, c.caller, c.body),
  'POST codex-callback': (c) => finishCodexLogin(c.deps, c.caller, c.body),
  'POST codex-device': (c) => beginDevice(c.deps, c.caller, c.body),
  'GET codex-poll': (c) => pollDevice(c.deps, c.caller, c.id),
  'POST openrouter-login': (c) => beginOpenRouter(c.deps, c.caller, c.body),
  'PATCH connection': (c) => patchModel(c.deps, c.caller, c.id, c.body),
  'DELETE connection': (c) => deleteModel(c.deps, c.caller, c.id),
  'GET models': (c) => listConnectionModels(c.deps, c.caller, c.id),
};

async function answer(req: IncomingMessage, deps: ModelsDeps, target: Target): Promise<unknown> {
  const caller = await callerOf(req, deps.keys);
  const method = req.method ?? 'GET';
  const route = `${method} ${target.kind}`;
  if (!MEMBER_READS.has(route) && caller.session.role !== 'admin') throw new ApiError('managing models needs the admin role in your organization', 403);
  const handler = ROUTES[route];
  if (handler === undefined) throw new ApiError('method not allowed', 405);
  const body = method === 'GET' || method === 'DELETE' ? {} : await readJsonBody(req, BODY_MAX);
  return handler({ deps, caller, body, id: target.id, query: new URLSearchParams((req.url ?? '').split('?')[1] ?? '') });
}

function callback(req: IncomingMessage, res: ServerResponse, deps: ModelsDeps): void {
  openRouterCallback(deps, new URLSearchParams((req.url ?? '').split('?')[1] ?? ''))
    .then((location) => {
      res.writeHead(302, { ...CALLBACK_HEADERS, location }).end();
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'models: an OpenRouter sign-in came back that Metro could not use');
      apiFailure(req, res, err, 'models');
    });
}

export function handleModelsApiRequest(req: IncomingMessage, res: ServerResponse, deps: ModelsDeps): boolean {
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
  if (target.kind === 'openrouter-callback') {
    callback(req, res, deps);
    return true;
  }
  answer(req, deps, target)
    .then((body) => {
      sendJson(req, res, target.kind === 'collection' && req.method === 'POST' ? 201 : 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'models');
    });
  return true;
}
