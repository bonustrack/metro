import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, requireAdmin, sendJson, type ApiSession } from '@metro-labs/http/api-http';
import { agentsDir } from '../agents/files.js';
import { removeClaudeLogin } from './claude-logins.js';
import { readClaudeLogins, type ClaudeLogin } from './claude-store.js';
import { effectiveSetup } from './effective.js';
import { chainStatus } from './fallback.js';
import { notReady, primaryRoute, type Connection, type ModelSetup } from './model-config.js';
import { orgModels, type SyncStatus } from './org-models.js';
import { claudeModels } from './provider-models.js';
import { lastServed } from './served.js';
import { refreshUsage, type UsageDeps } from './usage-refresh.js';
import { usageSeen } from './usage.js';

const PATH = '/api/model';
const SNAPSHOT = '/api/model/snapshot';
const SYNC = '/api/model/sync';
const CLAUDE_MODELS = '/api/model/claude-models';
const CLAUDE_LOGIN = '/api/model/claude/';
const LOGIN_RE = /^[A-Za-z0-9_-]{11}$/;

export interface ModelApiDeps extends UsageDeps {
  dir?: () => string;
  setup?: () => ModelSetup;
  sync?: () => Promise<void>;
  syncStatus?: () => SyncStatus;
  anthropicBase?: string;
}

const NO_SYNC: SyncStatus = { enrolled: false, at: null, error: null };

function publicConnection(c: Connection): Record<string, unknown> {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    model: c.model,
    hasKey: c.apiKey !== '',
    region: c.region,
    zdr: c.zdr,
    signedIn: c.codex !== null || (c.claude !== null && !c.signedOut),
    signedOut: c.signedOut,
    account: c.account.email,
    plan: c.account.plan,
    method: c.account.method,
  };
}

const loginsOf = (deps: ModelApiDeps): ClaudeLogin[] => readClaudeLogins(deps.dir?.() ?? agentsDir());
const setupOf = (deps: ModelApiDeps): ModelSetup => (deps.setup ?? (() => effectiveSetup(deps.dir?.())))();

export function settingsBody(deps: ModelApiDeps): Record<string, unknown> {
  const setup = setupOf(deps);
  const primary = primaryRoute(setup);
  const reason = primary === null ? null : notReady(primary);
  return {
    source: setup.source,
    sync: (deps.syncStatus ?? (() => orgModels()?.syncStatus() ?? NO_SYNC))(),
    route: primary?.connection.id ?? '',
    model: primary?.model ?? '',
    ready: reason === null,
    reason,
    connections: setup.connections.map(publicConnection),
    fallbacks: setup.fallbacks,
    chain: chainStatus(setup),
    claude: loginsOf(deps),
    lastServed: lastServed(),
    usage: usageSeen(),
  };
}

async function withUsage(deps: ModelApiDeps): Promise<Record<string, unknown>> {
  await refreshUsage(setupOf(deps), loginsOf(deps), deps);
  return settingsBody(deps);
}

async function synced(deps: ModelApiDeps): Promise<Record<string, unknown>> {
  await (deps.sync ?? (() => orgModels()?.sync() ?? Promise.resolve()))();
  return settingsBody(deps);
}

function dropLogin(session: ApiSession, login: string, deps: ModelApiDeps): Record<string, unknown> {
  requireAdmin(session);
  removeClaudeLogin(login, { ...deps.claudeLogins, dir: deps.dir?.() ?? deps.claudeLogins?.dir });
  return settingsBody(deps);
}

type Run = (session: ApiSession) => Promise<unknown>;

function routeFor(path: string, method: string | undefined, deps: ModelApiDeps): Run | number {
  const only = (wanted: string, run: Run): Run | number => (method === wanted ? run : 405);
  if (path === PATH) return only('GET', () => withUsage(deps));
  if (path === SNAPSHOT) return only('GET', () => Promise.resolve(settingsBody(deps)));
  if (path === SYNC) return only('POST', () => synced(deps));
  if (path === CLAUDE_MODELS) return only('GET', () => Promise.resolve({ models: claudeModels(deps.anthropicBase) }));
  const login = path.slice(CLAUDE_LOGIN.length);
  if (!LOGIN_RE.test(login)) return 404;
  return only('DELETE', (session) => Promise.resolve(dropLogin(session, login, deps)));
}

const mine = (path: string): boolean => path === PATH || path.startsWith(`${PATH}/`);

export function handleModelRequest(req: IncomingMessage, res: ServerResponse, deps: ModelApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!mine(path)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const route = path === PATH || path.startsWith(CLAUDE_LOGIN) || [SNAPSHOT, SYNC, CLAUDE_MODELS].includes(path) ? routeFor(path, req.method, deps) : 404;
  if (typeof route === 'number') {
    sendJson(req, res, route, { error: route === 404 ? 'not found' : 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      sendJson(req, res, 200, await route(session));
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'model-api');
    });
  return true;
}
