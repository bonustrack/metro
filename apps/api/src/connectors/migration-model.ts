import { createHmac, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { rawPublicKey } from '@metro-labs/http/agent-signature';
import { connectorPolicyOf } from '@metro-labs/http/connector-delivery';
import { migrationPayloadOf, migrationResponseOf, type MigrationContext, type MigrationPayload, type MigrationRequest, type MigrationResponse, type MigrationView } from '@metro-labs/http/connector-migration';
import type { AgentKeyRow } from '../db/agent-keys.js';
import { migrationConflict, type MigrationRow, type MigrationState } from '../db/connector-migrations.js';
import type { ConnectorRow } from '../db/connectors.js';
import { openConnectorSecret, type ConnectorSecret } from './model.js';
import { openSecret, sealSecret } from './secrets.js';

export function newMigration(key: Buffer, identity: AgentKeyRow, input: MigrationRequest, id: string, at: string): MigrationRow {
  const pair = generateKeyPairSync('x25519');
  const receivingSecret = sealSecret(key, identity.owner, id, { kind: 'migration-receiver', privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') });
  return { id, owner: identity.owner, agent: identity.agent, sourceId: input.sourceId, operationId: input.operationId, destinationId: newId(), keyId: identity.keyId, signingKey: identity.signingKey, sealingKey: identity.sealingKey, enrolledAt: identity.enrolledAt, phase: 'preparing', receivingKey: rawPublicKey(pair.publicKey), receivingSecret, snapshot: null, configStamp: null, retiredOperations: '[]', createdAt: at, updatedAt: at };
}

export const migrationContext = (row: MigrationRow): MigrationContext => ({ owner: row.owner, agent: row.agent, keyId: row.keyId, operationId: row.operationId, sourceId: row.sourceId, destinationId: row.destinationId });

export function receivingPrivateKey(key: Buffer, row: MigrationRow): KeyObject {
  const value = openSecret(key, row.owner, row.id, row.receivingSecret);
  if (!isRecord(value) || value.kind !== 'migration-receiver' || typeof value.privateKey !== 'string') throw migrationConflict();
  return createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(value.privateKey, 'base64url') });
}

export function migrationSnapshot(key: Buffer, row: MigrationRow): MigrationPayload | null {
  return row.snapshot === null ? null : migrationPayloadOf(openSecret(key, row.owner, row.id, row.snapshot));
}

function staticSecret(secret: ConnectorSecret): unknown {
  if (secret.kind !== 'oauth') return secret;
  if (secret.imported !== undefined) return { kind: secret.kind, targetUrl: secret.targetUrl, client: secret.client, server: { issuer: secret.server.issuer, tokenEndpoint: secret.server.tokenEndpoint }, tokenEndpointAuthMethod: secret.imported.tokenEndpointAuthMethod };
  return { kind: secret.kind, targetUrl: secret.targetUrl, client: secret.client, server: secret.server, ...(secret.oauthResource === undefined ? {} : { oauthResource: secret.oauthResource }) };
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => ordered(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

export const sameMigrationPayload = (one: MigrationPayload, two: MigrationPayload): boolean => JSON.stringify(ordered(one)) === JSON.stringify(ordered(two));

export function migrationConfigStamp(key: Buffer, row: ConnectorRow): string {
  const secret = openConnectorSecret(key, row);
  if (secret === null || secret.kind !== row.auth) throw migrationConflict();
  const policy: unknown = row.policy === null ? {} : JSON.parse(row.policy);
  return createHmac('sha256', key).update(JSON.stringify(ordered(['metro-connector-migration-config/v1', row.owner, row.id, row.name, row.url, row.auth, connectorPolicyOf(policy), staticSecret(secret)]))).digest('base64url');
}

export function ownsAssignment(state: MigrationState): boolean {
  return state.assignments.some((row) => row.agent === state.mapping.agent && row.migrationOperation === state.mapping.operationId && row.policy === null && row.createdBy === `agent:${state.mapping.agent}`);
}

function importedReadiness(secret: Extract<ConnectorSecret, { kind: 'oauth' }>): MigrationView['readiness'] | null {
  const state = secret.imported?.state;
  if (state === 'refreshing' || state === 'uncertain') return 'refresh_uncertain';
  return state === 'signin' ? 'signin' : null;
}

function authenticationReadiness(key: Buffer, row: ConnectorRow, now: number): MigrationView['readiness'] {
  const secret = openConnectorSecret(key, row);
  if (secret === null) return 'unavailable';
  if (secret.kind !== 'oauth') return 'ready';
  const imported = importedReadiness(secret);
  if (imported !== null) return imported;
  if (secret.tokens?.resource === undefined || (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= now)) return 'signin';
  return 'ready';
}

function assignmentsUnchanged(state: MigrationState): boolean {
  if (state.mapping.phase === 'prepared') return state.assignments.length === 0;
  return state.mapping.phase !== 'active' || ownsAssignment(state);
}

export function migrationReadiness(key: Buffer, state: MigrationState, now: number): MigrationView['readiness'] {
  if (state.mapping.phase === 'rolled_back') return 'pending';
  if (state.connector === null) return state.mapping.phase === 'preparing' ? 'pending' : 'unavailable';
  try {
    if (state.mapping.configStamp !== migrationConfigStamp(key, state.connector) || !assignmentsUnchanged(state)) return 'changed';
    return authenticationReadiness(key, state.connector, now);
  } catch {
    return 'unavailable';
  }
}

function sourceView(payload: MigrationPayload | null): Pick<MigrationView, 'name' | 'auth' | 'policy' | 'sourceStamp'> {
  return payload === null ? { name: null, auth: null, policy: null, sourceStamp: null } : { name: payload.name, auth: payload.auth.kind, policy: payload.policy, sourceStamp: payload.sourceStamp };
}

export function migrationResponse(key: Buffer, state: MigrationState, now: number, receiving = false): MigrationResponse {
  const row = state.mapping;
  const snapshot = migrationSnapshot(key, row);
  const migration = { grantImported: snapshot?.auth.kind === 'oauth' && snapshot.auth.grant !== undefined, operationId: row.operationId, sourceId: row.sourceId, destinationId: row.destinationId, phase: row.phase, readiness: migrationReadiness(key, state, now), ...sourceView(snapshot) };
  return migrationResponseOf({ migration, ...(receiving ? { receiving: { publicKey: row.receivingKey, context: migrationContext(row) } } : {}) });
}
