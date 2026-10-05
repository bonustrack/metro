import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { openrouterModels, openrouterZdrModels } from './openrouter.js';
import { anthropicModels, bedrockModels } from './provider-models.js';
import { routeOf, syncAvailableModelsQuietly } from '../claude/setup.js';
import { harnessRunner, runnerModel, sdkAllowed } from '../claude/runner.js';
import { sessionLive, sessionRunning, stopSession } from '../claude/session.js';
import { forgetOne, forgetReported } from './usage.js';
import {
  addConnection,
  connectionOf,
  parseModelConfig,
  readModelConfig,
  removeConnection,
  setFallbacks,
  setRoute,
  updateConnection,
  writeModelConfig,
  type ModelConfig,
} from './model-config.js';
import { asApiError, BODY_MAX, claudeLoginDeps, connectionFor, settingsBody, type ModelApiDeps, type Route, type Store } from './model-store.js';
import { dropUnusedClaudeLogins } from './claude-logins.js';
import { CODEX_ROUTES, codexDeviceRoute, GEMINI_ROUTES } from './model-signin.js';
import { refreshUsage } from './usage-refresh.js';
import { handleOpenRouterSignIn } from './openrouter-signin.js';

const PATH = '/api/model';
const CONNECTIONS = '/api/model/connections';
const FALLBACKS = '/api/model/fallbacks';
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

function restartRunningSession(): boolean {
  if (!sessionRunning()) return false;
  stopSession();
  return true;
}

function switchLive(before: ModelConfig, next: ModelConfig, deps: ModelApiDeps): void {
  const [was, now] = [runnerModel(before), runnerModel(next)];
  if (was === now) return;
  if (deps.switchModel?.(now) === true) log.info({ was, now }, 'model-api: the model changed, so the Agent SDK session switches to it live, with no restart');
  else if (runnerIsLive(deps)) throw new ApiError('The running Agent SDK could not be told about this model change. Nothing was saved. Let its work finish, stop it, then save and start it again.', 409);
}

function followModel(before: ModelConfig, next: ModelConfig, deps: ModelApiDeps): void {
  const restart = deps.restartSession ?? restartRunningSession;
  const agents = deps.setup?.agents;
  if (harnessRunner(agents) === 'sdk') {
    if (sdkAllowed(agents, next)) switchLive(before, next, deps);
    return;
  }
  if (routeOf(next) !== routeOf(before) && restart())
    log.info({ was: routeOf(before), now: routeOf(next) }, 'model-api: the model changed, so the Claude session restarts on it');
}

function kept(store: Store, next: ModelConfig, deps: ModelApiDeps, note: string, fields: Record<string, unknown>): unknown {
  const before = store.read();
  store.write(next);
  try {
    followModel(before, next, deps);
  } catch (err) {
    store.write(before);
    throw err;
  }
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

async function chooseFallbacks(req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const next = await withBody(req, (body) => setFallbacks(store.read(), body.fallbacks));
  return kept(store, next, deps, 'model-api: fallback models changed', { fallbacks: (next.fallbacks ?? []).map((f) => `${f.connection}:${f.model}`) });
}

async function create(req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const next = await withBody(req, (body) => addConnection(store.read(), body));
  return kept(store, next, deps, 'model-api: connection added', { connection: next.connections.at(-1)?.id ?? '' });
}

async function change(req: IncomingMessage, deps: ModelApiDeps, store: Store, id: string): Promise<unknown> {
  const before = connectionOf(store.read(), id)?.apiKey;
  const next = await withBody(req, (body) => updateConnection(store.read(), id, body));
  if (connectionOf(next, id)?.apiKey !== before) forgetReported(id);
  return kept(store, next, deps, 'model-api: connection changed', { connection: id });
}

function drop(deps: ModelApiDeps, store: Store, id: string): unknown {
  const before = store.read();
  let next: ModelConfig;
  try {
    next = removeConnection(before, id);
  } catch (err) {
    asApiError(err);
  }
  forgetOne(id);
  const body = kept(store, next, deps, 'model-api: connection removed', { connection: id });
  dropUnusedClaudeLogins(before, next, claudeLoginDeps(deps));
  return body;
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
  const before = store.read();
  const next = parseModelConfig(body);
  const answer = kept(store, next, deps, 'model-api: model setup restored from a file', {});
  dropUnusedClaudeLogins(before, next, claudeLoginDeps(deps));
  return answer;
}

function bundleRoute(path: string, method: string | undefined): Route | number {
  if (path === BUNDLE) return method === 'GET' ? { method: 'GET', run: (_req, _deps, store) => Promise.resolve(store.read()) } : 405;
  return method === 'POST' ? { method: 'POST', run: (req, deps, store) => restore(req, store, deps) } : 405;
}

function settingsRoute(path: string, method: string | undefined): Route | number {
  if (path === FALLBACKS) return method === 'PUT' ? { method: 'POST', run: chooseFallbacks } : 405;
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

const TABLES: [string, Record<string, Route>][] = [
  [OPENROUTER, OPENROUTER_ROUTES],
  [ANTHROPIC, ANTHROPIC_ROUTES],
  [BEDROCK, BEDROCK_ROUTES],
  [GEMINI, GEMINI_ROUTES],
];
const EXACT = new Set([PATH, FALLBACKS, BUNDLE, RESTORE, CONNECTIONS]);
const PREFIXES = [`${CONNECTIONS}/`, CODEX, ...TABLES.map(([prefix]) => prefix)];

const mine = (path: string): boolean => EXACT.has(path) || PREFIXES.some((prefix) => path.startsWith(prefix));

function routeFor(path: string, method: string | undefined): Route | number {
  if (path === PATH || path === FALLBACKS) return settingsRoute(path, method);
  if (path === BUNDLE || path === RESTORE) return bundleRoute(path, method);
  if (path === CONNECTIONS || path.startsWith(`${CONNECTIONS}/`)) return connectionsRoute(path, method);
  const table = TABLES.find(([prefix]) => path.startsWith(prefix));
  if (table !== undefined) return named(table[1], path.slice(table[0].length), method);
  return codexRoute(path.slice(CODEX.length), method);
}

const runnerIsLive = (deps: ModelApiDeps): boolean => (deps.sessionRunning ?? (() => sessionLive({ agents: deps.setup?.agents })))();

function checkRunnerRoute(before: ModelConfig, next: ModelConfig, deps: ModelApiDeps): void {
  const agents = deps.setup?.agents;
  if (harnessRunner(agents) !== 'sdk' || !sdkAllowed(agents, before) || sdkAllowed(agents, next)) return;
  if (runnerIsLive(deps))
    throw new ApiError('The Agent SDK session is running, and this change would leave a model or fallback it may not use. Let it finish its work, stop it, then save the change.', 409);
}

export function handleModelRequest(req: IncomingMessage, res: ServerResponse, deps: ModelApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!mine(path)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const store: Store = {
    read: deps.read ?? readModelConfig,
    write: (cfg) => {
      checkRunnerRoute(store.read(), cfg, deps);
      (deps.write ?? writeModelConfig)(cfg);
    },
  };
  if (handleOpenRouterSignIn(req, res, deps, store)) return true;
  const route = routeFor(path, req.method);
  if (typeof route === 'number') {
    sendJson(req, res, route, { error: route === 404 ? 'not found' : 'method not allowed' });
    return true;
  }
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
