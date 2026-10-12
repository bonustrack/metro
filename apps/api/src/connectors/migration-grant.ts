import { newId } from '@metro-labs/core/ids';
import type { MigrationPayload, MigrationRequest } from '@metro-labs/http/connector-migration';
import type { AgentKeyRow } from '../db/agent-keys.js';
import { migrationConflict, type MigrationState, type ConnectorMigrationStore } from '../db/connector-migrations.js';
import type { ConnectorRow } from '../db/connectors.js';
import type { SignInDeps } from './sign-in.js';
import { migrationConfigStamp, migrationSnapshot, sameMigrationPayload } from './migration-model.js';
import { detailOf, detailText, openConnectorSecret, sealConnectorSecret } from './model.js';
import { refreshImported } from './imported-refresh.js';

export function importGrant(key: Buffer, row: ConnectorRow, payload: MigrationPayload): ConnectorRow {
  if (payload.auth.kind !== 'oauth' || payload.auth.grant === undefined) throw migrationConflict();
  const grant = payload.auth.grant;
  const client = { clientId: grant.clientId, ...(grant.clientSecret === undefined ? {} : { clientSecret: grant.clientSecret }) };
  const server = { issuer: grant.issuer, tokenEndpoint: grant.tokenEndpoint, authorizationEndpoint: '', registrationEndpoint: null, supportsS256: true, scopes: [] };
  const tokens = { accessToken: grant.accessToken, resource: grant.resource, ...(grant.refreshToken === undefined ? {} : { refreshToken: grant.refreshToken }), ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) };
  const imported = { state: 'owned' as const, tokenEndpointAuthMethod: grant.tokenEndpointAuthMethod, ...(grant.scope === undefined ? {} : { scope: grant.scope }) };
  return { ...row, authGeneration: newId(), secret: sealConnectorSecret(key, row, { kind: 'oauth', targetUrl: payload.url, client, server, tokens, imported }), detail: detailText({ signedInAt: row.updatedAt }) };
}

function compatiblePayloads(held: MigrationPayload, payload: MigrationPayload): boolean {
  return held.auth.kind === 'oauth' && held.auth.grant === undefined && payload.auth.kind === 'oauth' && payload.auth.grant !== undefined;
}

function pristinePrepared(key: Buffer, state: MigrationState, row: ConnectorRow): boolean {
  return state.mapping.phase === 'prepared' && state.assignments.length === 0 && row.updatedAt === row.createdAt && detailOf(row.detail).signedInAt === undefined && state.mapping.configStamp === migrationConfigStamp(key, row);
}

export function canImportPrepared(key: Buffer, state: MigrationState, payload: MigrationPayload): boolean {
  const held = migrationSnapshot(key, state.mapping);
  const row = state.connector;
  if (row === null || held === null || !compatiblePayloads(held, payload)) return false;
  if (!pristinePrepared(key, state, row)) return false;
  const secret = openConnectorSecret(key, row);
  if (secret?.kind !== 'oauth' || secret.tokens !== undefined || secret.imported !== undefined) return false;
  return sameMigrationPayload(held, { ...payload, auth: { kind: 'oauth' }, sourceStamp: held.sourceStamp });
}

export async function refreshMigrationGrant(deps: Pick<SignInDeps, 'fetch' | 'now'> & { migrations: ConnectorMigrationStore }, key: Buffer, identity: AgentKeyRow, input: MigrationRequest, forced?: string): Promise<void> {
  await refreshImported({ key, now: deps.now, fetch: deps.fetch }, async (edit) => {
    await deps.migrations.change(identity, input, async (state) => {
      const row = state.connector;
      if (row === null || (state.mapping.phase !== 'prepared' && state.mapping.phase !== 'active')) return {};
      if (state.mapping.configStamp !== migrationConfigStamp(key, row)) return {};
      const change = await edit(row);
      return Object.keys(change.change).length === 0 ? {} : { connector: change.change };
    });
  }, forced);
}
