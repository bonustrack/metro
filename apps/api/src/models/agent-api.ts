import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, readBodyBytes, sendJson } from '@metro-labs/http/api-http';
import { AgentKeyMissing, refuseBrowser, type AgentAuth } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow, AgentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import type { AgentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import type { ModelDeliveryStore, RouteSource } from '@metro-labs/connectors/db/model-delivery';
import type { OrgModelStore } from '@metro-labs/connectors/db/models';
import { codexStale, refreshModelConnection } from '@metro-labs/connectors/model-refresh';
import type { ModelRoute } from '@metro-labs/connectors/model-route';
import { modelKey, refreshDeps } from './deps.js';
import { agentConnection, type AgentConnection } from './view.js';

const MODELS = '/api/agents/models';
const REFRESH = '/api/agents/models/refresh';
const BODY_MAX = 4096;

export interface AgentModelsDeps {
  key: () => Buffer | null;
  identities: Pick<AgentKeyStore, 'find'>;
  nonces: AgentNonceStore;
  auth: AgentAuth;
  store: OrgModelStore;
  delivery: ModelDeliveryStore;
  fetch: FetchLike;
  now: () => number;
}

export interface AgentModels {
  route: ModelRoute | null;
  source: RouteSource;
  connections: AgentConnection[];
  chatgptHostId: string;
}

interface Signed {
  identity: AgentKeyRow;
  body: unknown;
}

function bodyOf(bytes: Buffer): unknown {
  const text = bytes.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('The body must be JSON.', 400);
  }
}

async function signed(req: IncomingMessage, deps: AgentModelsDeps): Promise<Signed> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const proof = deps.auth.proofOf(req);
  const identity = await deps.identities.find(proof.keyId);
  if (identity === null) throw new AgentKeyMissing();
  deps.auth.accept(req, bytes, proof, identity.signingKey, identity.owner);
  await deps.nonces.consume(proof, identity.owner);
  return { identity, body: bodyOf(bytes) };
}

async function delivered(deps: AgentModelsDeps, identity: AgentKeyRow): Promise<AgentModels> {
  const key = modelKey(deps);
  const setup = await deps.delivery.setup(identity);
  const stale = setup.connections.filter((row) => codexStale(key, row, deps.now()));
  const fresh = await Promise.all(stale.map((row) => refreshModelConnection(refreshDeps(deps, key), identity.owner, row.id)));
  const rows = setup.connections.map((row) => fresh.find((held) => held.id === row.id) ?? row);
  return { route: setup.route, source: setup.source, connections: rows.map((row) => agentConnection(key, row)), chatgptHostId: setup.hostId };
}

function refreshInput(body: unknown): { connection: string; revision: number } {
  const input = isRecord(body) ? body : {};
  const connection = parseId(input.connection);
  const revision = input.revision;
  if (connection === null || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new ApiError('Send the connection id and the revision that was refused.', 400);
  return { connection, revision };
}

async function refreshed(deps: AgentModelsDeps, identity: AgentKeyRow, body: unknown): Promise<AgentConnection> {
  const key = modelKey(deps);
  const { connection, revision } = refreshInput(body);
  const setup = await deps.delivery.setup(identity);
  const row = setup.connections.find((held) => held.id === connection);
  if (row === undefined) throw new ApiError('The model route of this agent does not name that connection.', 404);
  const current = row.provider === 'codex' && row.revision === revision ? await refreshModelConnection(refreshDeps(deps, key), identity.owner, row.id, revision) : row;
  log.info({ agent: identity.agent, connection, revision, now: current.revision }, 'models: an agent asked for a fresh credential');
  return agentConnection(key, current);
}

async function route(path: string, req: IncomingMessage, deps: AgentModelsDeps): Promise<unknown> {
  const { identity, body } = await signed(req, deps);
  return path === MODELS ? delivered(deps, identity) : refreshed(deps, identity, body);
}

export function handleAgentModelsRequest(req: IncomingMessage, res: ServerResponse, deps: AgentModelsDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== MODELS && path !== REFRESH) return false;
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(path, req, deps)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      if (err instanceof AgentKeyMissing) sendJson(req, res, err.status, { error: err.message, code: 'agent_key_missing' });
      else apiFailure(req, res, err, 'agent-models');
    });
  return true;
}
