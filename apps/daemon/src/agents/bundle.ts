import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { apiFailure, apiSession, cors, readJsonBody, requireAdmin, sendJson } from '@metro-labs/http/api-http';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { parseId } from '@metro-labs/core/ids';
import type { LoadedAccount, LoadedAgent, LoadedConnector } from '../stations/materialize.js';
import { STATIONS } from '@metro-labs/core/station-names';

const AGENTS = '/api/agents';
const RESTORE_PATH = `${AGENTS}/restore`;
const BUNDLE_MAX = 2 * 1024 * 1024;
const STATION_NAMES = new Set<string>(STATIONS);

export interface AgentBundle {
  version: 1;
  agent: { id: string; name: string; stations: LoadedAccount[] };
  connectors: LoadedConnector[];
}

export const loadedAgentOf = (bundle: AgentBundle): LoadedAgent => ({
  id: bundle.agent.id,
  name: bundle.agent.name,
  key: null,
  accounts: bundle.agent.stations,
});

export interface RestoredAgent {
  id: string;
  name: string;
  stations: number;
  connectors: number;
}

export type ImportMode = 'append' | 'overwrite';

export interface BundleApiDeps {
  bundle: (agentId: string) => Promise<AgentBundle>;
  restore: (bundle: AgentBundle, mode: ImportMode) => Promise<RestoredAgent>;
}

export function parseMode(raw: unknown): ImportMode {
  const mode = isRecord(raw) && typeof raw.mode === 'string' ? raw.mode : 'overwrite';
  if (mode !== 'append' && mode !== 'overwrite') throw bad("mode is 'append' or 'overwrite'");
  return mode;
}

const bad = (what: string): ApiError => new ApiError(`bundle: ${what}`, 400);

function stationOf(raw: unknown): LoadedAccount {
  if (!isRecord(raw) || typeof raw.station !== 'string' || !STATION_NAMES.has(raw.station))
    throw bad('a station is not a known station');
  if (typeof raw.id !== 'string' || !isRecord(raw.config)) throw bad('a station has no id or config');
  const allowlist = Array.isArray(raw.allowlist)
    ? raw.allowlist.filter((s): s is string => typeof s === 'string')
    : null;
  return { station: raw.station as LoadedAccount['station'], id: raw.id, allowlist, enabled: raw.enabled !== false, config: raw.config };
}

function connectorOf(raw: unknown): LoadedConnector {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.url !== 'string')
    throw bad('a connector is missing its id, name or url');
  if (!isRecord(raw.config)) throw bad('a connector has no config');
  return { id: raw.id, name: raw.name, url: raw.url, transport: 'http', config: raw.config };
}

function agentOf(raw: unknown): AgentBundle['agent'] {
  if (!isRecord(raw)) throw bad('not a v1 agent bundle');
  const { id, name, stations } = raw;
  if (typeof id !== 'string' || parseId(id) === null) throw bad('agent id is not an id');
  if (!Array.isArray(stations)) throw bad('agent has no station list');
  return { id, name: typeof name === 'string' ? name : '', stations: stations.map(stationOf) };
}

export function parseBundle(raw: unknown): AgentBundle {
  if (!isRecord(raw) || raw.version !== 1) throw bad('not a v1 agent bundle');
  const connectors = Array.isArray(raw.connectors) ? raw.connectors : [];
  return { version: 1, agent: agentOf(raw.agent), connectors: connectors.map(connectorOf) };
}

async function answer(req: IncomingMessage, deps: BundleApiDeps, path: string): Promise<unknown> {
  if (path === RESTORE_PATH) {
    const body: unknown = await readJsonBody(req, BUNDLE_MAX);
    return deps.restore(parseBundle(body), parseMode(body));
  }
  const id = parseId(path.slice(AGENTS.length + 1).split('/')[0] ?? '');
  if (id === null) throw new ApiError('no such agent', 404);
  return deps.bundle(id);
}

export function handleBundleRequest(req: IncomingMessage, res: ServerResponse, deps: BundleApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const isRestore = path === RESTORE_PATH;
  const isBundle = /^\/api\/agents\/[^/]+\/bundle$/.test(path);
  if (!isRestore && !isBundle) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== (isRestore ? 'POST' : 'GET')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then((session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      requireAdmin(session);
      return answer(req, deps, path);
    })
    .then((body) => {
      sendJson(req, res, isRestore ? 201 : 200, body);
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError) apiFailure(req, res, err, 'bundle-api');
      else {
        log.warn({ err: errMsg(err) }, 'bundle-api: request failed');
        if (!res.headersSent) sendJson(req, res, 500, { error: 'bundle api failed' });
      }
    });
  return true;
}
