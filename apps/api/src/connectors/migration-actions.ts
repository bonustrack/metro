import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { openConnectorMigration, type MigrationPayload, type MigrationRequest, type MigrationResponse } from '@metro-labs/http/connector-migration';
import { verifyRemoteMcp, type ConnectorAuth } from '@metro-labs/http/connector-mcp';
import { OAuthResourceRequired } from '@metro-labs/http/connector-resource';
import { ConnectorUnauthorized, parseConnectorUrl } from '@metro-labs/http/connector-url';
import type { AgentKeyRow } from '../db/agent-keys.js';
import { migrationConflict, type ConnectorMigrationStore, type MigrationState } from '../db/connector-migrations.js';
import type { ConnectorRow } from '../db/connectors.js';
import { detailText, openConnectorSecret, sealConnectorSecret } from './model.js';
import { migrationConfigStamp, migrationContext, migrationReadiness, migrationResponse, migrationSnapshot, newMigration, ownsAssignment, receivingPrivateKey, sameMigrationPayload } from './migration-model.js';
import { canImportPrepared, importGrant, refreshMigrationGrant } from './migration-grant.js';
import { credentialRevision } from './delivery-model.js';
import { sealSecret } from './secrets.js';
import { prepareSignIn, type SignInDeps } from './sign-in.js';

export interface MigrationDeps extends SignInDeps {
  key: () => Buffer | null;
  migrations: ConnectorMigrationStore;
}

const at = (deps: MigrationDeps): string => new Date(deps.now()).toISOString();
const read = (deps: MigrationDeps, identity: AgentKeyRow, input: MigrationRequest): Promise<MigrationState> => deps.migrations.change(identity, input, () => ({}));

async function preparedConnector(deps: MigrationDeps, key: Buffer, state: MigrationState, payload: MigrationPayload): Promise<ConnectorRow> {
  const now = at(deps);
  const url = parseConnectorUrl(payload.url);
  const row: ConnectorRow = { id: state.mapping.destinationId, owner: state.mapping.owner, name: payload.name, url: url.origin, auth: payload.auth.kind, authGeneration: newId(), policy: JSON.stringify(payload.policy), secret: null, detail: null, createdBy: `agent:${state.mapping.agent}`, createdAt: now, updatedAt: now };
  try {
    if (payload.auth.kind === 'oauth' && payload.auth.grant !== undefined) return importGrant(key, row, payload);
    if (payload.auth.kind === 'oauth') {
      const { server, client, resource } = await prepareSignIn(deps, url, payload.client, payload.oauthResource);
      row.secret = sealConnectorSecret(key, row, { kind: 'oauth', targetUrl: payload.url, server, client, oauthResource: resource });
      row.detail = detailText({ issuer: server.issuer, ...(payload.client === null ? {} : { clientId: payload.client.clientId }) });
    } else {
      await verifyRemoteMcp(url, payload.auth, deps.fetch);
      row.secret = sealConnectorSecret(key, row, { ...payload.auth, targetUrl: payload.url });
      row.detail = detailText({ server: url.hostname, verifiedAt: now, ...(payload.auth.kind === 'header' ? { header: payload.auth.name } : {}) });
    }
  } catch (err) {
    if (err instanceof OAuthResourceRequired) throw err;
    throw new ApiError('The destination could not be prepared. Check its connection and try again.', 409);
  }
  return row;
}

async function prepare(deps: MigrationDeps, key: Buffer, identity: AgentKeyRow, input: Extract<MigrationRequest, { sealed: unknown }>): Promise<MigrationState> {
  const before = await read(deps, identity, input);
  const payload = openConnectorMigration(receivingPrivateKey(key, before.mapping), migrationContext(before.mapping), input.sealed);
  const held = migrationSnapshot(key, before.mapping);
  if (held !== null) {
    if (sameMigrationPayload(held, payload)) return before;
    if (input.action !== 'handover' || !canImportPrepared(key, before, payload)) throw migrationConflict();
  }
  if (held === null && before.mapping.phase !== 'preparing') throw migrationConflict();
  const connector = await preparedConnector(deps, key, before, payload);
  return deps.migrations.change(identity, input, (current) => {
    const stored = migrationSnapshot(key, current.mapping);
    if (stored !== null) {
      if (sameMigrationPayload(stored, payload)) return {};
      if (input.action !== 'handover' || !canImportPrepared(key, current, payload)) throw migrationConflict();
      return { connector: { secret: connector.secret, authGeneration: connector.authGeneration ?? newId(), detail: connector.detail }, mapping: { snapshot: sealSecret(key, current.mapping.owner, current.mapping.id, payload), configStamp: migrationConfigStamp(key, connector), updatedAt: at(deps) } };
    }
    if (current.mapping.phase !== 'preparing' || current.connector !== null || current.mapping.destinationId !== connector.id) throw migrationConflict();
    return { create: connector, mapping: { phase: 'prepared', snapshot: sealSecret(key, current.mapping.owner, current.mapping.id, payload), configStamp: migrationConfigStamp(key, connector), updatedAt: at(deps) } };
  });
}

async function verifyDestination(deps: MigrationDeps, key: Buffer, state: MigrationState): Promise<void> {
  if (state.connector === null || migrationReadiness(key, state, deps.now()) !== 'ready') throw migrationConflict();
  const secret = openConnectorSecret(key, state.connector);
  if (secret === null) throw migrationConflict();
  let auth: ConnectorAuth;
  if (secret.kind === 'oauth') {
    if (secret.tokens === undefined) throw migrationConflict();
    auth = { kind: 'oauth', issuer: secret.server.issuer, tokenEndpoint: secret.server.tokenEndpoint, clientId: secret.client.clientId, ...secret.tokens };
  } else auth = secret;
  try {
    await verifyRemoteMcp(parseConnectorUrl(secret.targetUrl), auth, deps.fetch);
  } catch (error) {
    if (error instanceof ConnectorUnauthorized) throw error;
    throw new ApiError('The destination is not ready. Check its connection or sign in again.', 409);
  }
}

async function activate(deps: MigrationDeps, key: Buffer, identity: AgentKeyRow, input: MigrationRequest): Promise<MigrationState> {
  await refreshMigrationGrant(deps, key, identity, input);
  let before = await read(deps, identity, input);
  if (before.mapping.phase !== 'prepared' && before.mapping.phase !== 'active') throw migrationConflict();
  try { await verifyDestination(deps, key, before); }
  catch (error) {
    if (!(error instanceof ConnectorUnauthorized) || before.connector === null) throw error;
    await refreshMigrationGrant(deps, key, identity, input, credentialRevision(key, before.connector));
    before = await read(deps, identity, input);
    await verifyDestination(deps, key, before);
  }
  return deps.migrations.change(identity, input, (current) => {
    if (current.connector === null || before.connector === null) throw migrationConflict();
    if (migrationReadiness(key, current, deps.now()) !== 'ready') throw migrationConflict();
    if (current.connector.secret !== before.connector.secret || current.connector.authGeneration !== before.connector.authGeneration) throw migrationConflict();
    if (current.mapping.phase === 'active' && ownsAssignment(current)) return {};
    if (current.mapping.phase !== 'prepared' || current.assignments.length !== 0) throw migrationConflict();
    return { assignment: 'create', mapping: { phase: 'active', updatedAt: at(deps) } };
  });
}

async function rollback(deps: MigrationDeps, key: Buffer, identity: AgentKeyRow, input: MigrationRequest): Promise<MigrationState> {
  await deps.migrations.begin(identity, (id) => ({ ...newMigration(key, identity, input, id, at(deps)), phase: 'rolled_back' }), false);
  return deps.migrations.change(identity, input, (state) => {
    if (state.mapping.phase === 'rolled_back') return {};
    const snapshot = migrationSnapshot(key, state.mapping);
    if (snapshot?.auth.kind === 'oauth' && snapshot.auth.grant !== undefined) throw new ApiError('Central owns the imported OAuth grant. Finish forward or sign in centrally; the old local tokens cannot be restored.', 409);
    return { ...(ownsAssignment(state) ? { assignment: 'remove' as const } : {}), mapping: { phase: 'rolled_back', updatedAt: at(deps) } };
  });
}

export async function runMigration(deps: MigrationDeps, identity: AgentKeyRow, input: MigrationRequest): Promise<MigrationResponse> {
  const key = deps.key();
  if (key === null) throw new ApiError('Metro cannot keep connector secrets yet.', 503);
  let state: MigrationState;
  if (input.action === 'begin') state = await deps.migrations.begin(identity, (id) => newMigration(key, identity, input, id, at(deps)));
  else if (input.action === 'prepare' || input.action === 'handover') state = await prepare(deps, key, identity, input);
  else if (input.action === 'activate') state = await activate(deps, key, identity, input);
  else if (input.action === 'rollback') state = await rollback(deps, key, identity, input);
  else state = await read(deps, identity, input);
  if (['prepare', 'handover', 'status'].includes(input.action) && state.connector !== null) {
    await refreshMigrationGrant(deps, key, identity, input);
    state = await read(deps, identity, input);
  }
  return migrationResponse(key, state, deps.now(), input.action === 'begin');
}
