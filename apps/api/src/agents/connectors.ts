import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, readBodyBytes, sendJson } from '@metro-labs/http/api-http';
import { CONNECTOR_DELIVERY_LEASE_MS, sealConnectorDelivery, type SealedDelivery } from '@metro-labs/http/connector-delivery';
import { deliveredConnector } from '../connectors/delivery-model.js';
import { boundedDeliverySnapshot } from '../connectors/delivery-snapshot.js';
import { refreshAssigned, type RefreshRequest } from '../connectors/refresh.js';
import type { AgentKeyStore } from '../db/agent-keys.js';
import type { AgentNonceStore } from '../db/agent-nonces.js';
import type { ConnectorDeliveryStore } from '../db/connector-delivery.js';
import { AgentKeyMissing, refuseBrowser, type AgentAuth } from './auth.js';

const PATH = '/api/agents/connectors';
const BODY_MAX = 4096;

export interface AgentConnectorsDeps {
  key: () => Buffer | null;
  keys: AgentKeyStore;
  nonces: AgentNonceStore;
  store: ConnectorDeliveryStore;
  auth: AgentAuth;
  fetch: FetchLike;
  now: () => number;
}

interface DeliveryRequest {
  requestId: string;
  refresh?: RefreshRequest;
}

const invalid = (): ApiError => new ApiError('Invalid connector delivery request.', 400);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;

function inputOf(bytes: Buffer): DeliveryRequest {
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!isRecord(body) || Object.keys(body).some((key) => !['requestId', 'refresh'].includes(key)) || !opaque(body.requestId)) throw invalid();
  if (!Object.hasOwn(body, 'refresh')) return { requestId: body.requestId };
  const refresh = body.refresh;
  if (!isRecord(refresh) || Object.keys(refresh).some((key) => !['connectorId', 'revision'].includes(key)) || !opaque(refresh.revision)) throw invalid();
  const connectorId = parseId(refresh.connectorId);
  if (connectorId === null) throw invalid();
  return { requestId: body.requestId, refresh: { connectorId, revision: refresh.revision } };
}

async function answer(req: IncomingMessage, deps: AgentConnectorsDeps): Promise<{ sealed: SealedDelivery }> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const input = inputOf(bytes);
  const proof = deps.auth.proofOf(req);
  const identity = await deps.keys.find(proof.keyId);
  if (identity === null) throw new AgentKeyMissing();
  deps.auth.accept(req, bytes, proof, identity.signingKey, identity.owner);
  await deps.nonces.consume(proof, identity.owner);
  const key = deps.key();
  if (key === null) throw new ApiError('Metro cannot open connector secrets yet.', 503);
  const failed = await refreshAssigned({ key, store: deps.store, fetch: deps.fetch, now: deps.now }, identity, input.refresh);
  const context = { owner: identity.owner, agent: identity.agent, keyId: identity.keyId, requestId: input.requestId };
  const sealed = await deps.store.seal(identity, (rows) => {
    const issuedAt = deps.now();
    const layered = new URLSearchParams((req.url ?? '').split('?')[1]).get('policy_layers') === '1';
    const connectors = rows.map((row) => deliveredConnector(key, row, issuedAt, failed, layered));
    return sealConnectorDelivery(identity.sealingKey, context, boundedDeliverySnapshot({ version: 1, issuedAt, expiresAt: issuedAt + CONNECTOR_DELIVERY_LEASE_MS, connectors }));
  });
  return { sealed };
}

export function handleAgentConnectorsRequest(req: IncomingMessage, res: ServerResponse, deps: AgentConnectorsDeps): boolean {
  if ((req.url ?? '').split('?')[0] !== PATH) return false;
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  answer(req, deps).then((body) => {
    sendJson(req, res, 200, body);
  }).catch((err: unknown) => {
    if (err instanceof AgentKeyMissing) sendJson(req, res, err.status, { error: err.message, code: 'agent_key_missing' });
    else {
      const message = err instanceof Error && err.message === 'Connector delivery is too large.' ? err.message : 'Connector delivery is unavailable. Try again.';
      apiFailure(req, res, err instanceof ApiError ? err : new ApiError(message, 503), 'agent-connectors');
    }
  });
  return true;
}
