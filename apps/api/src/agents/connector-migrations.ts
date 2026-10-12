import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuthResourceRequired } from '@metro-labs/http/connector-resource';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, readBodyBytes, sendJson } from '@metro-labs/http/api-http';
import { CONNECTOR_MIGRATION_MAX_BYTES, migrationRequestOf, type MigrationRequest, type MigrationResponse } from '@metro-labs/http/connector-migration';
import { runMigration, type MigrationDeps } from '../connectors/migration-actions.js';
import { MigrationConflict } from '../db/connector-migrations.js';
import type { AgentKeyStore } from '../db/agent-keys.js';
import type { AgentNonceStore } from '../db/agent-nonces.js';
import { AgentKeyMissing, refuseBrowser, type AgentAuth } from './auth.js';

export interface AgentMigrationsDeps extends MigrationDeps {
  enabled: () => boolean;
  deliveryEnabled: () => boolean;
  keys: AgentKeyStore;
  nonces: AgentNonceStore;
  auth: AgentAuth;
}

function inputOf(bytes: Buffer): MigrationRequest {
  try {
    return migrationRequestOf(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    throw new ApiError('Invalid connector migration request.', 400);
  }
}

async function answer(req: IncomingMessage, deps: AgentMigrationsDeps): Promise<MigrationResponse> {
  if (!deps.enabled() || !deps.deliveryEnabled()) throw new ApiError('Organization connector migration is not switched on yet.', 503);
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, CONNECTOR_MIGRATION_MAX_BYTES);
  const input = inputOf(bytes);
  const proof = deps.auth.proofOf(req);
  const identity = await deps.keys.find(proof.keyId);
  if (identity === null) throw new AgentKeyMissing();
  deps.auth.accept(req, bytes, proof, identity.signingKey, identity.owner);
  await deps.nonces.consume(proof, identity.owner);
  return runMigration(deps, identity, input);
}

export function handleAgentMigrationsRequest(req: IncomingMessage, res: ServerResponse, deps: AgentMigrationsDeps): boolean {
  if ((req.url ?? '').split('?')[0] !== '/api/agents/connector-migrations') return false;
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  answer(req, deps).then((body) => {
    sendJson(req, res, 200, body);
  }).catch((err: unknown) => {
    if (err instanceof OAuthResourceRequired) sendJson(req, res, err.status, { error: err.message, code: 'oauth_resource_required' });
    else if (err instanceof MigrationConflict) sendJson(req, res, err.status, { error: err.message, code: 'migration_conflict' });
    else if (err instanceof AgentKeyMissing) sendJson(req, res, err.status, { error: err.message, code: 'agent_key_missing' });
    else apiFailure(req, res, err instanceof ApiError ? err : new ApiError('Connector migration is unavailable. Check its status and try again.', 409), 'agent-connector-migrations');
  });
  return true;
}
