import type { IncomingMessage, ServerResponse } from 'node:http';
import { EFFORT_DEFAULTS } from '@metro-labs/core/effort';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, cors, sendJson } from '@metro-labs/http/api-http';
import { effectiveSetup } from './effective.js';
import { chainStatus } from '@metro-labs/inference/fallback';
import { helperSetup, notReady, primaryRoute, type Connection, type ModelSetup } from '@metro-labs/inference/model-config';
import { orgModels, type SyncStatus } from './org-models.js';
import { lastServed } from '@metro-labs/inference/served';
import { refreshUsage, type UsageDeps } from '@metro-labs/inference/usage-refresh';
import { usageSeen } from '@metro-labs/inference/usage';

const PATH = '/api/model';
const SNAPSHOT = '/api/model/snapshot';
const SYNC = '/api/model/sync';

export interface ModelApiDeps extends UsageDeps {
  setup?: () => ModelSetup;
  sync?: () => Promise<void>;
  syncStatus?: () => SyncStatus;
}

const NO_SYNC: SyncStatus = { enrolled: false, at: null, error: null };
const NO_MODEL = "No model is set up for this agent yet: choose one on the organization's Gateway page.";

function publicConnection(c: Connection): Record<string, unknown> {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    model: c.model,
    hasKey: c.apiKey !== '',
    subscription: c.claudeToken !== '',
    region: c.region,
    zdr: c.zdr,
    signedOut: c.signedOut,
    account: c.account.email,
    plan: c.account.plan,
    method: c.account.method,
  };
}

const setupOf = (deps: ModelApiDeps): ModelSetup => (deps.setup ?? (() => effectiveSetup()))();

function helpersBody(setup: ModelSetup): Record<string, unknown> | null {
  const helpers = helperSetup(setup);
  if (helpers === null) return null;
  const primary = primaryRoute(helpers);
  return { route: primary?.connection.id ?? '', model: primary?.model ?? '', fallbacks: helpers.fallbacks, chain: chainStatus(helpers) };
}

export function settingsBody(deps: ModelApiDeps): Record<string, unknown> {
  const setup = setupOf(deps);
  const primary = primaryRoute(setup);
  const reason = primary === null ? NO_MODEL : notReady(primary);
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
    helpers: helpersBody(setup),
    effort: { ...EFFORT_DEFAULTS, ...setup.effort },
    lastServed: lastServed(),
    usage: usageSeen(),
  };
}

async function withUsage(deps: ModelApiDeps): Promise<Record<string, unknown>> {
  await refreshUsage(setupOf(deps), deps);
  return settingsBody(deps);
}

async function synced(deps: ModelApiDeps): Promise<Record<string, unknown>> {
  await (deps.sync ?? (() => orgModels()?.requested() ?? Promise.resolve()))();
  return settingsBody(deps);
}

type Run = () => Promise<unknown>;

const ROUTES: Record<string, [string, (deps: ModelApiDeps) => Promise<unknown>]> = {
  [PATH]: ['GET', withUsage],
  [SNAPSHOT]: ['GET', (deps) => Promise.resolve(settingsBody(deps))],
  [SYNC]: ['POST', synced],
};

function routeFor(path: string, method: string | undefined, deps: ModelApiDeps): Run | number {
  const known = ROUTES[path];
  if (known === undefined) return 404;
  const [wanted, run] = known;
  return method === wanted ? () => run(deps) : 405;
}

const mine = (path: string): boolean => path === PATH || path.startsWith(`${PATH}/`);

export function handleModelRequest(req: IncomingMessage, res: ServerResponse, deps: ModelApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!mine(path)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const route = routeFor(path, req.method, deps);
  if (typeof route === 'number') {
    sendJson(req, res, route, { error: route === 404 ? 'not found' : 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      sendJson(req, res, 200, await route());
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'model-api');
    });
  return true;
}
