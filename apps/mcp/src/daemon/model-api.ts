import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { apiFailure, apiSession, cors, readJsonBody, sendJson } from './api-http.js';
import { isRecord } from './is-record.js';
import { log } from './log.js';
import { beginLogin, CodexAuthError, finishLogin, readCodexCliAuth } from '../gateway/codex-auth.js';
import { beginDeviceLogin, pollDeviceLogin } from '../gateway/codex-device.js';
import { codexModels, currentTokens, freshCodexState } from '../gateway/codex.js';
import type { CodexTokens } from '../gateway/codex-auth.js';
import { GatewayError } from '../gateway/forward.js';
import {
  applyModelUpdate,
  ModelConfigError,
  publicModelConfig,
  readModelConfig,
  setCodexAuth,
  writeModelConfig,
  type ModelConfig,
} from '../gateway/model-config.js';

const PATH = '/api/model';
const CODEX = '/api/model/codex/';
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

function asApiError(err: unknown): never {
  if (err instanceof ModelConfigError || err instanceof CodexAuthError) throw new ApiError(err.message, 400);
  if (err instanceof GatewayError) throw new ApiError(err.message, 502);
  throw err;
}

async function update(req: IncomingMessage, store: Store): Promise<unknown> {
  const patch = await readJsonBody(req, BODY_MAX);
  let next: ModelConfig;
  try {
    next = applyModelUpdate(store.read(), patch);
  } catch (err) {
    asApiError(err);
  }
  store.write(next);
  log.info({ provider: next.provider }, 'model-api: route updated');
  return publicModelConfig(next);
}

function saveCodex(store: Store, cfg: ModelConfig, note: string): unknown {
  store.write(cfg);
  log.info({ signedIn: cfg.codex.auth !== null, plan: cfg.codex.auth?.plan ?? null }, note);
  return publicModelConfig(cfg);
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

function routeFor(path: string, method: string | undefined): Route | number {
  if (path === PATH) {
    if (method === 'GET') return { method: 'GET', run: (_req, _deps, store) => Promise.resolve(publicModelConfig(store.read())) };
    if (method === 'PUT') return { method: 'POST', run: (req, _deps, store) => update(req, store) };
    return 405;
  }
  const rest = path.slice(CODEX.length);
  const route = CODEX_ROUTES[rest];
  if (route !== undefined) return route.method === method ? route : 405;
  const id = rest.startsWith(DEVICE_PREFIX) ? rest.slice(DEVICE_PREFIX.length) : '';
  if (!DEVICE_ID_RE.test(id)) return 404;
  return method === 'GET' ? { method: 'GET', run: (_req, deps, store) => pollDevice(id, deps, store) } : 405;
}

export function handleModelRequest(req: IncomingMessage, res: ServerResponse, deps: ModelApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH && !path.startsWith(CODEX)) return false;
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
