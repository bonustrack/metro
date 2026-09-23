import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { openrouterModels, openrouterZdrModels } from './openrouter.js';
import { anthropicModels, bedrockModels } from './provider-models.js';
import { syncAvailableModelsQuietly } from '../claude/setup.js';
import { forgetOne } from './usage.js';
import {
  addConnection,
  parseModelConfig,
  readModelConfig,
  removeConnection,
  setRoute,
  updateConnection,
  writeModelConfig,
  type ModelConfig,
} from './model-config.js';
import { asApiError, BODY_MAX, connectionFor, settingsBody, type ModelApiDeps, type Route, type Store } from './model-store.js';
import { CODEX_ROUTES, codexDeviceRoute, GEMINI_ROUTES, refreshUsage } from './model-signin.js';

const PATH = '/api/model';
const CONNECTIONS = '/api/model/connections';
const CODEX = '/api/model/codex/';
const GEMINI = '/api/model/gemini/';
const OPENROUTER = '/api/model/openrouter/';
const ANTHROPIC = '/api/model/anthropic/';
const BEDROCK = '/api/model/bedrock/';
const BUNDLE = '/api/model/bundle';
const RESTORE = '/api/model/restore';
const RESTORE_MAX = 64 * 1024;
const DEVICE_PREFIX = 'device/';
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type { ModelApiDeps } from './model-store.js';

function kept(store: Store, next: ModelConfig, deps: ModelApiDeps, note: string, fields: Record<string, unknown>): unknown {
  store.write(next);
  syncAvailableModelsQuietly(deps.setup ?? {}, next);
  log.info(fields, note);
  return settingsBody(next);
}

async function withBody(req: IncomingMessage, run: (body: Record<string, unknown>) => ModelConfig): Promise<ModelConfig> {
  const body = await readJsonBody(req, BODY_MAX);
  if (!isRecord(body)) throw new ApiError('body must be a JSON object', 400);
  try {
    return run(body);
  } catch (err) {
    return asApiError(err);
  }
}

async function chooseRoute(req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const next = await withBody(req, (body) => setRoute(store.read(), typeof body.route === 'string' ? body.route : ''));
  return kept(store, next, deps, 'model-api: route changed', { route: next.route });
}

async function create(req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const next = await withBody(req, (body) => addConnection(store.read(), body));
  return kept(store, next, deps, 'model-api: connection added', { connection: next.connections.at(-1)?.id ?? '' });
}

async function change(req: IncomingMessage, deps: ModelApiDeps, store: Store, id: string): Promise<unknown> {
  const next = await withBody(req, (body) => updateConnection(store.read(), id, body));
  return kept(store, next, deps, 'model-api: connection changed', { connection: id });
}

function drop(deps: ModelApiDeps, store: Store, id: string): unknown {
  let next: ModelConfig;
  try {
    next = removeConnection(store.read(), id);
  } catch (err) {
    asApiError(err);
  }
  forgetOne(id);
  return kept(store, next, deps, 'model-api: connection removed', { connection: id });
}

async function settingsWithUsage(deps: ModelApiDeps, store: Store): Promise<Record<string, unknown>> {
  await refreshUsage(deps, store);
  return settingsBody(store.read());
}

const OPENROUTER_ROUTES: Record<string, Route> = {
  models: { method: 'GET', run: async (_req, deps) => ({ models: await openrouterModels(deps.openrouterBase, deps.fetchImpl).catch(asApiError) }) },
  zdr: { method: 'GET', run: async (_req, deps) => ({ models: await openrouterZdrModels(deps.openrouterBase, deps.fetchImpl).catch(asApiError) }) },
};

const ANTHROPIC_ROUTES: Record<string, Route> = {
  models: {
    method: 'GET',
    run: async (req, deps, store) => ({ models: await anthropicModels(connectionFor(store.read(), req, 'anthropic'), deps.anthropicBase, deps.fetchImpl).catch(asApiError) }),
  },
};

const BEDROCK_ROUTES: Record<string, Route> = {
  models: {
    method: 'GET',
    run: async (req, deps, store) => ({ models: await bedrockModels(connectionFor(store.read(), req, 'bedrock'), deps.bedrockControlBase, deps.fetchImpl).catch(asApiError) }),
  },
};

const named = (table: Record<string, Route>, name: string, method: string | undefined): Route | number => {
  const route = table[name];
  if (route === undefined) return 404;
  return route.method === method ? route : 405;
};

async function restore(req: IncomingMessage, store: Store, deps: ModelApiDeps): Promise<unknown> {
  const body = await readJsonBody(req, RESTORE_MAX);
  if (!isRecord(body)) throw new ApiError('body must be a JSON object', 400);
  return kept(store, parseModelConfig(body), deps, 'model-api: model setup restored from a file', {});
}

function bundleRoute(path: string, method: string | undefined): Route | number {
  if (path === BUNDLE) return method === 'GET' ? { method: 'GET', run: (_req, _deps, store) => Promise.resolve(store.read()) } : 405;
  return method === 'POST' ? { method: 'POST', run: (req, deps, store) => restore(req, store, deps) } : 405;
}

function settingsRoute(method: string | undefined): Route | number {
  if (method === 'GET') return { method: 'GET', run: (_req, deps, store) => settingsWithUsage(deps, store) };
  if (method === 'PUT') return { method: 'POST', run: chooseRoute };
  return 405;
}

function connectionsRoute(path: string, method: string | undefined): Route | number {
  if (path === CONNECTIONS) return method === 'POST' ? { method: 'POST', run: create } : 405;
  const id = path.slice(CONNECTIONS.length + 1);
  if (id === '' || id.includes('/')) return 404;
  if (method === 'PUT') return { method: 'POST', run: (req, deps, store) => change(req, deps, store, id) };
  if (method === 'DELETE') return { method: 'GET', run: (_req, deps, store) => Promise.resolve(drop(deps, store, id)) };
  return 405;
}

function codexRoute(rest: string, method: string | undefined): Route | number {
  if (rest in CODEX_ROUTES) return named(CODEX_ROUTES, rest, method);
  const id = rest.startsWith(DEVICE_PREFIX) ? rest.slice(DEVICE_PREFIX.length) : '';
  if (!DEVICE_ID_RE.test(id)) return 404;
  return codexDeviceRoute(id, method);
}

const mine = (path: string): boolean =>
  path === PATH ||
  path === BUNDLE ||
  path === RESTORE ||
  path === CONNECTIONS ||
  path.startsWith(`${CONNECTIONS}/`) ||
  path.startsWith(CODEX) ||
  path.startsWith(GEMINI) ||
  path.startsWith(OPENROUTER) ||
  path.startsWith(ANTHROPIC) ||
  path.startsWith(BEDROCK);

function routeFor(path: string, method: string | undefined): Route | number {
  if (path === PATH) return settingsRoute(method);
  if (path === BUNDLE || path === RESTORE) return bundleRoute(path, method);
  if (path === CONNECTIONS || path.startsWith(`${CONNECTIONS}/`)) return connectionsRoute(path, method);
  if (path.startsWith(OPENROUTER)) return named(OPENROUTER_ROUTES, path.slice(OPENROUTER.length), method);
  if (path.startsWith(ANTHROPIC)) return named(ANTHROPIC_ROUTES, path.slice(ANTHROPIC.length), method);
  if (path.startsWith(BEDROCK)) return named(BEDROCK_ROUTES, path.slice(BEDROCK.length), method);
  if (path.startsWith(GEMINI)) return named(GEMINI_ROUTES, path.slice(GEMINI.length), method);
  return codexRoute(path.slice(CODEX.length), method);
}

export function handleModelRequest(req: IncomingMessage, res: ServerResponse, deps: ModelApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!mine(path)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const route = routeFor(path, req.method);
  if (typeof route === 'number') {
    sendJson(req, res, route, { error: route === 404 ? 'not found' : 'method not allowed' });
    return true;
  }
  const store: Store = { read: deps.read ?? readModelConfig, write: deps.write ?? writeModelConfig };
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      sendJson(req, res, 200, await route.run(req, deps, store));
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'model-api');
    });
  return true;
}
