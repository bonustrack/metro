import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { apiFailure, readBodyBytes, sendJson } from '@metro-labs/http/api-http';
import { AgentKeyMissing, refuseBrowser, type AgentAuth } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow, AgentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import type { AgentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import type { ModelDeliveryStore } from '@metro-labs/connectors/db/model-delivery';
import type { OrgModelStore } from '@metro-labs/connectors/db/models';
import { modelKey, refreshDeps } from './deps.js';
import { agentModelsOf, type AgentConnection, type AgentModels } from '@metro-labs/connectors/model-agent';

const MODELS = '/api/agents/models';
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

async function signed(req: IncomingMessage, deps: AgentModelsDeps): Promise<AgentKeyRow> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const proof = deps.auth.proofOf(req);
  const identity = await deps.identities.find(proof.keyId);
  if (identity === null) throw new AgentKeyMissing();
  deps.auth.accept(req, bytes, proof, identity.signingKey, identity.owner);
  await deps.nonces.consume(proof, identity.owner);
  return identity;
}

const factsOnly = (connection: AgentConnection): AgentConnection => ({ ...connection, credential: null });

async function delivered(deps: AgentModelsDeps, identity: AgentKeyRow): Promise<AgentModels> {
  const models = await agentModelsOf(refreshDeps(deps, modelKey(deps)), await deps.delivery.setup(identity), identity.owner);
  return { ...models, connections: models.connections.map(factsOnly) };
}

export function handleAgentModelsRequest(req: IncomingMessage, res: ServerResponse, deps: AgentModelsDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== MODELS) return false;
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  signed(req, deps)
    .then((identity) => delivered(deps, identity))
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      if (err instanceof AgentKeyMissing) sendJson(req, res, err.status, { error: err.message, code: 'agent_key_missing' });
      else apiFailure(req, res, err, 'agent-models');
    });
  return true;
}
