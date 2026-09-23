import type { IncomingMessage } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { beginLogin, finishLogin, readCodexCliAuth, type CodexTokens } from './codex-auth.js';
import { beginDeviceLogin, pollDeviceLogin } from './codex-device.js';
import { codexModels, currentTokens, sharedCodexState } from './codex.js';
import { beginLogin as beginGeminiLogin, exchangeCode as exchangeGeminiCode, userEmail, type GeminiTokens } from './gemini-auth.js';
import { onboard, parseGeminiProject } from './gemini-setup.js';
import { currentGeminiTokens, listGeminiModels, sharedGeminiState, type GeminiDeps } from './gemini.js';
import { openrouterCredits } from './openrouter.js';
import { lastServed } from './served.js';
import { geminiUsage, noteUsage, openrouterUsage, usageOf } from './usage.js';
import {
  addConnection,
  connectionOf,
  setCodexAuth,
  setGeminiAuth,
  type Connection,
  type ModelConfig,
  type Provider,
} from './model-config.js';
import { asApiError, askedConnection, BODY_MAX, connectionFor, CREDITS_TTL_MS, settingsBody, type ModelApiDeps, type Route, type Store } from './model-store.js';


function connectionToFill(store: Store, req: IncomingMessage, provider: Provider): { cfg: ModelConfig; id: string } {
  const asked = askedConnection(req);
  const current = store.read();
  if (asked !== '') {
    if (connectionOf(current, asked)?.provider !== provider) throw new ApiError('no such connection', 404);
    return { cfg: current, id: asked };
  }
  const cfg = addConnection(current, { provider });
  return { cfg, id: cfg.connections.at(-1)?.id ?? '' };
}

const saved = (store: Store, cfg: ModelConfig, note: string, fields: Record<string, unknown>): unknown => {
  store.write(cfg);
  log.info(fields, note);
  return settingsBody(cfg);
};

function keepCodex(store: Store, req: IncomingMessage, tokens: CodexTokens | null, note: string): unknown {
  const { cfg, id } = connectionToFill(store, req, 'codex');
  const next = setCodexAuth(cfg, id, tokens);
  return saved(store, next, note, { connection: id, plan: tokens?.plan ?? null });
}

async function pollDevice(id: string, req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const result = await pollDeviceLogin(id, deps.fetchImpl).catch(asApiError);
  if (result.status !== 'done') return result;
  return { status: 'done', settings: keepCodex(store, req, result.tokens, 'model-api: Codex connected by device code') };
}

const codexDepsFor = (deps: ModelApiDeps, store: Store, id: string): { issuer?: string; fetchImpl?: typeof fetch; base?: string; save: (connId: string, t: CodexTokens) => void } => ({
  issuer: deps.issuer,
  fetchImpl: deps.fetchImpl,
  base: deps.codexBase,
  save: (connId, t) => {
    store.write(setCodexAuth(store.read(), connId === '' ? id : connId, t));
  },
});

export const CODEX_ROUTES: Record<string, Route> = {
  device: {
    method: 'POST',
    run: async (_req, deps) => {
      const login = await beginDeviceLogin(deps.issuer, deps.fetchImpl).catch(asApiError);
      return { id: login.id, user_code: login.userCode, verify_url: login.verifyUrl, interval: login.interval };
    },
  },
  login: { method: 'POST', run: (_req, deps) => Promise.resolve({ url: beginLogin(deps.issuer).url }) },
  callback: {
    method: 'POST',
    run: async (req, deps, store) => {
      const body = await readJsonBody(req, BODY_MAX);
      const raw = isRecord(body) && typeof body.url === 'string' ? body.url : '';
      const tokens = await finishLogin(raw, deps.issuer, deps.fetchImpl).catch(asApiError);
      return keepCodex(store, req, tokens, 'model-api: Codex connected');
    },
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
      return Promise.resolve(keepCodex(store, _req, tokens, 'model-api: Codex CLI login imported'));
    },
  },
  models: {
    method: 'GET',
    run: async (req, deps, store) => {
      const conn = connectionFor(store.read(), req, 'codex');
      if (conn.codex === null) throw new ApiError('this connection is not signed in yet', 400);
      const codexDeps = codexDepsFor(deps, store, conn.id);
      const auth = await currentTokens(conn, codexDeps, sharedCodexState).catch(asApiError);
      return { models: await codexModels(auth, codexDeps).catch(asApiError) };
    },
  },
};

export const geminiDeps = (deps: ModelApiDeps, store: Store): GeminiDeps => ({
  base: deps.geminiBase,
  tokenBase: deps.geminiTokenBase,
  fetchImpl: deps.fetchImpl,
  save: (id, t) => {
    store.write(setGeminiAuth(store.read(), id, t));
  },
});

async function geminiModelsOf(conn: Connection, deps: ModelApiDeps, store: Store): Promise<Awaited<ReturnType<typeof listGeminiModels>>> {
  if (conn.gemini === null) throw new ApiError('this connection is not signed in yet', 400);
  const tokens = await currentGeminiTokens(conn, geminiDeps(deps, store), sharedGeminiState);
  return listGeminiModels(tokens, geminiDeps(deps, store));
}

function projectOf(body: unknown): string | null {
  try {
    return parseGeminiProject(isRecord(body) ? body.project : null);
  } catch (err) {
    return asApiError(err);
  }
}

async function connectGemini(req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<unknown> {
  const body = await readJsonBody(req, BODY_MAX);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  const state = isRecord(body) && typeof body.state === 'string' ? body.state : '';
  const project = projectOf(body);
  const tokens = await exchangeGeminiCode(code, state, deps.geminiTokenBase, deps.fetchImpl).catch(asApiError);
  const email = await userEmail(tokens, deps.geminiUserBase, deps.fetchImpl);
  const onboarded = await onboard(tokens, project, deps.geminiBase, deps.fetchImpl).catch(asApiError);
  const { cfg, id } = connectionToFill(store, req, 'gemini');
  const full: GeminiTokens = { ...tokens, email, project: onboarded.project, tier: onboarded.tier };
  return saved(store, setGeminiAuth(cfg, id, full), 'model-api: Gemini connected', { connection: id, tier: onboarded.tier });
}

export const GEMINI_ROUTES: Record<string, Route> = {
  login: { method: 'POST', run: (_req, deps) => Promise.resolve(beginGeminiLogin(deps.geminiAuthBase)) },
  code: { method: 'POST', run: connectGemini },
  models: {
    method: 'GET',
    run: async (req, deps, store) => ({ models: (await geminiModelsOf(connectionFor(store.read(), req, 'gemini'), deps, store).catch(asApiError)).map((m) => m.id) }),
  },
};

export function codexDeviceRoute(id: string, method: string | undefined): Route | number {
  return method === 'GET' ? { method: 'GET', run: (req, deps, store) => pollDevice(id, req, deps, store) } : 405;
}

async function refreshOne(conn: Connection, deps: ModelApiDeps, now: number): Promise<void> {
  if (conn.apiKey === '') return;
  const seen = usageOf(conn.id);
  if (seen !== undefined && now - Date.parse(seen.at) < CREDITS_TTL_MS) return;
  try {
    const credits = await openrouterCredits(conn.apiKey, deps.openrouterBase, deps.fetchImpl);
    noteUsage(conn.id, openrouterUsage(credits.total, credits.spent, new Date(now)));
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'model-api: could not read the OpenRouter credits');
  }
}

const modelsInUse = (conn: Connection): Set<string> => {
  const served = lastServed();
  return new Set([conn.model, served?.connection === conn.id ? served.model : ''].filter((m) => m !== ''));
};

async function refreshQuota(conn: Connection, deps: ModelApiDeps, store: Store, now: number): Promise<void> {
  if (conn.gemini === null) return;
  const inUse = modelsInUse(conn);
  const seen = usageOf(conn.id);
  const covers = seen !== undefined && [...inUse].every((id) => seen.windows.some((w) => w.label === id));
  if (seen !== undefined && covers && now - Date.parse(seen.at) < CREDITS_TTL_MS) return;
  try {
    const rows = (await geminiModelsOf(conn, deps, store)).filter((m) => inUse.has(m.id));
    const usage = geminiUsage(rows, new Date(now));
    if (usage !== null) noteUsage(conn.id, usage);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'model-api: could not read the Gemini quota');
  }
}

export async function refreshUsage(deps: ModelApiDeps, store: Store, now = Date.now()): Promise<void> {
  for (const conn of store.read().connections) {
    if (conn.provider === 'openrouter') await refreshOne(conn, deps, now);
    if (conn.provider === 'gemini') await refreshQuota(conn, deps, store, now);
  }
}
