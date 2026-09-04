import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { apiFailure, apiSession, cors, readJsonBody, sendJson } from './api-http.js';
import { ApiError } from './api-error.js';
import { isRecord } from './is-record.js';
import { parseId } from '../db/ids.js';
import type { LoadedAccount, LoadedAgent, LoadedConnector } from '../db/materialize.js';
import { STATIONS } from '../db/stations.js';

const AGENTS = '/api/agents';
const RESTORE_PATH = `${AGENTS}/restore`;
const BUNDLE_MAX = 2 * 1024 * 1024;
const STATION_NAMES = new Set<string>(STATIONS);

export interface AgentBundle {
  version: 1;
  agent: { id: string; name: string; key: string; stations: LoadedAccount[] };
  connectors: LoadedConnector[];
}

export const loadedAgentOf = (bundle: AgentBundle): LoadedAgent => ({
  id: bundle.agent.id,
  name: bundle.agent.name,
  key: bundle.agent.key,
  accounts: bundle.agent.stations,
  connectors: [],
});

export interface RestoredAgent {
  id: string;
  name: string;
  stations: number;
  connectors: number;
}

export interface BundleApiDeps {
  bundle: (subject: string, agentId: string) => Promise<AgentBundle>;
  restore: (subject: string, bundle: AgentBundle) => Promise<RestoredAgent>;
}

const bad = (what: string): ApiError => new ApiError(`bundle: ${what}`, 400);

function stationOf(raw: unknown): LoadedAccount {
  if (!isRecord(raw) || typeof raw.station !== 'string' || !STATION_NAMES.has(raw.station))
    throw bad('a station is not a known station');
  if (typeof raw.id !== 'string' || !isRecord(raw.config)) throw bad('a station has no id or config');
  const allowlist = Array.isArray(raw.allowlist)
    ? raw.allowlist.filter((s): s is string => typeof s === 'string')
    : null;
  return { station: raw.station as LoadedAccount['station'], id: raw.id, allowlist, config: raw.config };
}

function connectorOf(raw: unknown): LoadedConnector {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.url !== 'string')
    throw bad('a connector is missing its id, name or url');
  if (!isRecord(raw.config)) throw bad('a connector has no config');
  return { id: raw.id, name: raw.name, url: raw.url, transport: 'http', config: raw.config };
}

function agentOf(raw: unknown): AgentBundle['agent'] {
  if (!isRecord(raw)) throw bad('not a v1 agent bundle');
  const { id, name, key, stations } = raw;
  if (typeof id !== 'string' || parseId(id) === null) throw bad('agent id is not an id');
  if (typeof name !== 'string' || typeof key !== 'string' || key === '') throw bad('agent has no name or key');
  if (!Array.isArray(stations)) throw bad('agent has no station list');
  return { id, name, key, stations: stations.map(stationOf) };
}

export function parseBundle(raw: unknown): AgentBundle {
  if (!isRecord(raw) || raw.version !== 1) throw bad('not a v1 agent bundle');
  const connectors = Array.isArray(raw.connectors) ? raw.connectors : [];
  return { version: 1, agent: agentOf(raw.agent), connectors: connectors.map(connectorOf) };
}

async function answer(req: IncomingMessage, deps: BundleApiDeps, subject: string, path: string): Promise<unknown> {
  if (path === RESTORE_PATH) return deps.restore(subject, parseBundle(await readJsonBody(req, BUNDLE_MAX)));
  const id = parseId(path.slice(AGENTS.length + 1).split('/')[0] ?? '');
  if (id === null) throw new ApiError('no such agent', 404);
  return deps.bundle(subject, id);
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
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  answer(req, deps, session.subject, path)
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
