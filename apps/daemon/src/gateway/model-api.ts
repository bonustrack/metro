import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { beginLogin, CodexAuthError, finishLogin, readCodexCliAuth } from './codex-auth.js';
import { beginDeviceLogin, pollDeviceLogin } from './codex-device.js';
import { codexModels, currentTokens, freshCodexState } from './codex.js';
import { openrouterModels, openrouterZdrModels } from './openrouter.js';
import { anthropicModels, bedrockModels } from './provider-models.js';
import { syncAvailableModelsQuietly, type SetupDeps } from '../claude/setup.js';
import { lastServed } from './served.js';
import type { CodexTokens } from './codex-auth.js';
import { GatewayError } from './forward.js';
import {
  applyModelUpdate,
  ModelConfigError,
  publicModelConfig,
  readModelConfig,
  setCodexAuth,
  writeModelConfig,
  type ModelConfig,
} from './model-config.js';

const PATH = '/api/model';
const CODEX = '/api/model/codex/';
const OPENROUTER = '/api/model/openrouter/';
const ANTHROPIC = '/api/model/anthropic/';
const BEDROCK = '/api/model/bedrock/';
const BODY_MAX = 16 * 1024;
const DEVICE_PREFIX = 'device/';
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface ModelApiDeps {
  authorize: (subject: string) => void;
  read?: () => ModelConfig;
  write?: (cfg: ModelConfig) => void;
  issuer?: string;
  fetchImpl?: typeof fetch;
  codexHome?: string;
  codexBase?: string;
  openrouterBase?: string;
  anthropicBase?: string;
  bedrockControlBase?: string;
  setup?: SetupDeps;
}

interface Store {
  read: () => ModelConfig;
  write: (cfg: ModelConfig) => void;
}

type Handler = (req: IncomingMessage, deps: ModelApiDeps, store: Store) => Promise<unknown>;

interface Route {
  method: 'GET' | 'POST';
  run: Handler;
}

const settingsBody = (cfg: ModelConfig): Record<string, unknown> => ({ ...publicModelConfig(cfg), lastServed: lastServed() });

function asApiError(err: unknown): never {
  if (err instanceof ModelConfigError || err instanceof CodexAuthError) throw new ApiError(err.message, 400);
  if (err instanceof GatewayError) throw new ApiError(err.message, err.status >= 400 && err.status < 500 ? 400 : 502);
  throw err;
}

async function update(req: IncomingMessage, store: Store, deps: ModelApiDeps): Promise<unknown> {
  const patch = await readJsonBody(req, BODY_MAX);
  let next: ModelConfig;
  try {
    next = applyModelUpdate(store.read(), patch);
  } catch (err) {
    asApiError(err);
  }
  store.write(next);
  syncAvailableModelsQuietly(deps.setup ?? {}, next);
  log.info({ provider: next.provider }, 'model-api: route updated');
  return settingsBody(next);
}

function saveCodex(store: Store, cfg: ModelConfig, note: string): unknown {
  store.write(cfg);
  log.info({ signedIn: cfg.codex.auth !== null, plan: cfg.codex.auth?.plan ?? null }, note);
  return settingsBody(cfg);
}

const modelApiState = freshCodexState();

async function pollDevice(id: string, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const result = await pollDeviceLogin(id, deps.fetchImpl).catch(asApiError);
  if (result.status !== 'done') return result;
  return { status: 'done', settings: saveCodex(store, setCodexAuth(store.read(), result.tokens), 'model-api: Codex connected by device code') };
}

const CODEX_ROUTES: Record<string, Route> = {
  device: {
    method: 'POST',
    run: async (_req, deps) => {
      const login = await beginDeviceLogin(deps.issuer, deps.fetchImpl).catch(asApiError);
      return { id: login.id, user_code: login.userCode, verify_url: login.verifyUrl, interval: login.interval };
    },
  },
  login: {
    method: 'POST',
    run: (_req, deps) => Promise.resolve({ url: beginLogin(deps.issuer).url }),
  },
  callback: {
    method: 'POST',
    run: async (req, deps, store) => {
      const body = await readJsonBody(req, BODY_MAX);
      const raw = isRecord(body) && typeof body.url === 'string' ? body.url : '';
      const tokens = await finishLogin(raw, deps.issuer, deps.fetchImpl).catch(asApiError);
      return saveCodex(store, setCodexAuth(store.read(), tokens), 'model-api: Codex connected');
    },
  },
  logout: {
    method: 'POST',
    run: (_req, _deps, store) => Promise.resolve(saveCodex(store, setCodexAuth(store.read(), null), 'model-api: Codex disconnected')),
  },
  import: {
    method: 'POST',
    run: (_req, deps, store) => {
      let tokens;
      try {
        tokens = readCodexCliAuth(deps.codexHome);
      } catch (err) {
        asApiError(err);
      }
      return Promise.resolve(saveCodex(store, setCodexAuth(store.read(), tokens), 'model-api: Codex CLI login imported'));
    },
  },
  models: {
    method: 'GET',
    run: async (_req, deps, store) => {
      const cfg = store.read();
      if (cfg.codex.auth === null) throw new ApiError('Codex is not connected: sign in with ChatGPT first', 400);
      const codexDeps = { issuer: deps.issuer, fetchImpl: deps.fetchImpl, base: deps.codexBase, save: (t: CodexTokens) => { store.write(setCodexAuth(store.read(), t)); } };
      const auth = await currentTokens(cfg, codexDeps, modelApiState).catch(asApiError);
      const models = await codexModels(auth, codexDeps).catch(asApiError);
      return { models };
    },
  },
};

const OPENROUTER_ROUTES: Record<string, Route> = {
  models: {
    method: 'GET',
    run: async (_req, deps) => ({ models: await openrouterModels(deps.openrouterBase, deps.fetchImpl).catch(asApiError) }),
  },
  zdr: {
    method: 'GET',
    run: async (_req, deps) => ({ models: await openrouterZdrModels(deps.openrouterBase, deps.fetchImpl).catch(asApiError) }),
  },
};

const ANTHROPIC_ROUTES: Record<string, Route> = {
  models: {
    method: 'GET',
    run: async (_req, deps, store) => ({ models: await anthropicModels(store.read().anthropic, deps.anthropicBase, deps.fetchImpl).catch(asApiError) }),
  },
};

const BEDROCK_ROUTES: Record<string, Route> = {
  models: {
    method: 'GET',
    run: async (_req, deps, store) => ({ models: await bedrockModels(store.read().bedrock, deps.bedrockControlBase, deps.fetchImpl).catch(asApiError) }),
  },
};

const named = (table: Record<string, Route>, name: string, method: string | undefined): Route | number => {
  const route = table[name];
  if (route === undefined) return 404;
  return route.method === method ? route : 405;
};

function settingsRoute(method: string | undefined): Route | number {
  if (method === 'GET') return { method: 'GET', run: (_req, _deps, store) => Promise.resolve(settingsBody(store.read())) };
  if (method === 'PUT') return { method: 'POST', run: (req, deps, store) => update(req, store, deps) };
  return 405;
}

function codexRoute(rest: string, method: string | undefined): Route | number {
  if (rest in CODEX_ROUTES) return named(CODEX_ROUTES, rest, method);
  const id = rest.startsWith(DEVICE_PREFIX) ? rest.slice(DEVICE_PREFIX.length) : '';
  if (!DEVICE_ID_RE.test(id)) return 404;
  return method === 'GET' ? { method: 'GET', run: (_req, deps, store) => pollDevice(id, deps, store) } : 405;
}

const mine = (path: string): boolean =>
  path === PATH || path.startsWith(CODEX) || path.startsWith(OPENROUTER) || path.startsWith(ANTHROPIC) || path.startsWith(BEDROCK);

function routeFor(path: string, method: string | undefined): Route | number {
  if (path === PATH) return settingsRoute(method);
  if (path.startsWith(OPENROUTER)) return named(OPENROUTER_ROUTES, path.slice(OPENROUTER.length), method);
  if (path.startsWith(ANTHROPIC)) return named(ANTHROPIC_ROUTES, path.slice(ANTHROPIC.length), method);
  if (path.startsWith(BEDROCK)) return named(BEDROCK_ROUTES, path.slice(BEDROCK.length), method);
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
      deps.authorize(session.subject);
      sendJson(req, res, 200, await route.run(req, deps, store));
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'model-api');
    });
  return true;
}
