import type { IncomingMessage } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { beginLogin, chatgptHostId, finishLogin, type CodexTokens } from './codex-auth.js';
import { codexModels, currentTokens, sharedCodexState, type CodexDeps } from './codex.js';
import { beginLogin as beginGeminiLogin, exchangeCode as exchangeGeminiCode, userEmail, type GeminiTokens } from './gemini-auth.js';
import { onboard, parseGeminiProject } from './gemini-setup.js';
import { currentGeminiTokens, listGeminiModels, sharedGeminiState, type GeminiDeps } from './gemini.js';
import { listCache } from './model-lists.js';
import { forgetReported } from './usage.js';
import {
  addConnection,
  connectionOf,
  setCodexAuth,
  setGeminiAuth,
  type Connection,
  type ModelConfig,
  type Provider,
} from './model-config.js';
import { asApiError, askedConnection, BODY_MAX, connectionFor, settingsBody, type ModelApiDeps, type Route, type Store } from './model-store.js';

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

const saved = (store: Store, cfg: ModelConfig, note: string, fields: { connection: string } & Record<string, unknown>): unknown => {
  store.write(cfg);
  forgetReported(fields.connection);
  log.info(fields, note);
  return settingsBody(cfg);
};

const codexDepsFor = (deps: ModelApiDeps, store: Store, id: string): CodexDeps => ({
  issuer: deps.issuer,
  fetchImpl: deps.fetchImpl,
  base: deps.codexBase,
  save: (connId, t) => {
    store.write(setCodexAuth(store.read(), connId === '' ? id : connId, t));
  },
});

const renewing = (store: Store, req: IncomingMessage): CodexTokens | null => (askedConnection(req) === '' ? null : connectionFor(store.read(), req, 'codex').codex);

export const CODEX_ROUTES: Record<string, Route> = {
  login: {
    method: 'POST',
    run: (req, deps, store) => Promise.resolve({ url: beginLogin(renewing(store, req), chatgptHostId(deps.setup?.agents), deps.issuer) }),
  },
  callback: {
    method: 'POST',
    run: async (req, deps, store) => {
      const body = await readJsonBody(req, BODY_MAX);
      const raw = isRecord(body) && typeof body.url === 'string' ? body.url : '';
      const tokens = await finishLogin(raw, deps.issuer, deps.fetchImpl).catch(asApiError);
      const { cfg, id } = connectionToFill(store, req, 'codex');
      return saved(store, setCodexAuth(cfg, id, tokens), 'model-api: Codex connected with Sign in with ChatGPT', { connection: id });
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

const geminiDeps = (deps: ModelApiDeps, store: Store): GeminiDeps => ({
  base: deps.geminiBase,
  tokenBase: deps.geminiTokenBase,
  fetchImpl: deps.fetchImpl,
  save: (id, t) => {
    store.write(setGeminiAuth(store.read(), id, t));
  },
});

export async function geminiModelsOf(conn: Connection, deps: ModelApiDeps, store: Store): Promise<Awaited<ReturnType<typeof listGeminiModels>>> {
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

const geminiLists = listCache<string>('gemini');

async function geminiIds(req: IncomingMessage, deps: ModelApiDeps, store: Store): Promise<string[]> {
  const conn = connectionFor(store.read(), req, 'gemini');
  const key = `${deps.geminiBase ?? ''}:${conn.id}:${conn.gemini?.email ?? ''}:${conn.gemini?.project ?? ''}`;
  return geminiLists.get(key, async () => (await geminiModelsOf(conn, deps, store)).map((m) => m.id));
}

export const GEMINI_ROUTES: Record<string, Route> = {
  login: { method: 'POST', run: (_req, deps) => Promise.resolve(beginGeminiLogin(deps.geminiAuthBase)) },
  code: { method: 'POST', run: connectGemini },
  models: {
    method: 'GET',
    run: async (req, deps, store) => ({ models: await geminiIds(req, deps, store).catch(asApiError) }),
  },
};
