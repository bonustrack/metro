import type { KeyObject } from 'node:crypto';
import { parseId } from '@metro-labs/core/ids';
import { sealingKeyOf } from './agent-signature.js';
import { deliveryBytes, deliveryRecord } from './connector-delivery-validation.js';
import { connectorAuth, connectorClient, connectorName } from './connector-input.js';
import type { OAuthClient } from './connector-oauth.js';
import { connectorPolicyOf, type ConnectorPolicy } from './connector-policy.js';
import { parseConnectorUrl } from './connector-url.js';
import { openTransfer, sealTransfer, type SealedTransfer } from './transfer-crypto.js';
import { isOrganizationId } from './workos-token.js';

export const CONNECTOR_MIGRATION_MAX_BYTES = 96 * 1024;
const PAYLOAD_MAX = 60 * 1024;

export interface MigrationContext {
  owner: string;
  agent: string;
  keyId: string;
  operationId: string;
  sourceId: string;
  destinationId: string;
}

export interface MigrationPayload {
  name: string;
  url: string;
  auth: { kind: 'none' } | { kind: 'header'; name: string; value: string } | { kind: 'oauth' };
  client: OAuthClient | null;
  policy: ConnectorPolicy;
  sourceStamp: string;
}

export interface MigrationView {
  operationId: string;
  sourceId: string;
  destinationId: string;
  phase: 'preparing' | 'prepared' | 'active' | 'rolled_back';
  readiness: 'pending' | 'ready' | 'signin' | 'changed' | 'unavailable';
  name: string | null;
  auth: 'none' | 'header' | 'oauth' | null;
  policy: ConnectorPolicy | null;
  sourceStamp: string | null;
}

export interface MigrationResponse {
  migration: MigrationView;
  receiving?: { publicKey: string; context: MigrationContext };
}

export type MigrationRequest = { action: 'begin' | 'status' | 'activate' | 'rollback'; operationId: string; sourceId: string } | { action: 'prepare'; operationId: string; sourceId: string; sealed: unknown };

const invalid = (): Error => new Error('Invalid connector migration.');
const idOf = (value: unknown): string => {
  const id = parseId(value);
  if (id === null) throw invalid();
  return id;
};

export function migrationRequestOf(raw: unknown): MigrationRequest {
  const value = deliveryRecord(raw, ['action', 'operationId', 'sourceId', 'sealed']);
  const operationId = idOf(value.operationId);
  const sourceId = idOf(value.sourceId);
  if (value.action === 'prepare' && Object.hasOwn(value, 'sealed')) return { action: 'prepare', operationId, sourceId, sealed: value.sealed };
  if (Object.hasOwn(value, 'sealed')) throw invalid();
  if (value.action !== 'begin' && value.action !== 'status' && value.action !== 'activate' && value.action !== 'rollback') throw invalid();
  return { action: value.action, operationId, sourceId };
}

function contextOf(raw: unknown): MigrationContext {
  const value = deliveryRecord(raw, ['owner', 'agent', 'keyId', 'operationId', 'sourceId', 'destinationId']);
  if (typeof value.owner !== 'string' || !isOrganizationId(value.owner) || typeof value.keyId !== 'string') throw invalid();
  deliveryBytes(value.keyId, 32);
  return { owner: value.owner, agent: idOf(value.agent), keyId: value.keyId, operationId: idOf(value.operationId), sourceId: idOf(value.sourceId), destinationId: idOf(value.destinationId) };
}

function contextBytes(context: MigrationContext): Buffer {
  const value = contextOf(context);
  return Buffer.from(JSON.stringify(['metro-connector-migration/v1', value.owner, value.agent, value.keyId, value.operationId, value.sourceId, value.destinationId]));
}

function authOf(raw: unknown): MigrationPayload['auth'] {
  const value = deliveryRecord(raw, ['kind', 'name', 'value']);
  if (value.kind === 'header') {
    const auth = connectorAuth(value.name, value.value);
    if (auth.kind !== 'header' || auth.name !== value.name || auth.value !== value.value || ['__proto__', 'constructor', 'prototype'].includes(auth.name)) throw invalid();
    return auth;
  }
  if ((value.kind !== 'none' && value.kind !== 'oauth') || Object.hasOwn(value, 'name') || Object.hasOwn(value, 'value')) throw invalid();
  return { kind: value.kind };
}

function clientOf(raw: unknown): OAuthClient | null {
  if (raw === null) return null;
  const value = deliveryRecord(raw, ['clientId', 'clientSecret']);
  const client = connectorClient(value.clientId, value.clientSecret);
  if (client === null || client.clientId !== value.clientId || client.clientSecret !== value.clientSecret) throw invalid();
  return client;
}

function canonicalResource(raw: unknown, url: URL): boolean {
  return raw === `${url.origin}${url.pathname}` || (url.pathname === '/' && raw === url.origin);
}

function migrationClient(auth: MigrationPayload['auth'], url: URL, input: Record<string, unknown>): OAuthClient | null {
  const client = clientOf(input.client);
  if (auth.kind !== 'oauth' && client !== null) throw invalid();
  if (auth.kind === 'oauth' && (url.search !== '' || !['/', '/mcp'].includes(url.pathname) || !canonicalResource(input.url, url))) throw invalid();
  return client;
}

export function migrationPayloadOf(raw: unknown): MigrationPayload {
  const value = deliveryRecord(raw, ['name', 'url', 'auth', 'client', 'policy', 'sourceStamp']);
  if (typeof value.name !== 'string' || connectorName(value.name) !== value.name || typeof value.url !== 'string' || typeof value.sourceStamp !== 'string') throw invalid();
  const url = parseConnectorUrl(value.url);
  if (url.protocol !== 'https:' || value.url.length > 2048) throw invalid();
  deliveryBytes(value.sourceStamp, 32);
  const auth = authOf(value.auth);
  const client = migrationClient(auth, url, value);
  const payload = { name: value.name, url: value.url, auth, client, policy: connectorPolicyOf(value.policy), sourceStamp: value.sourceStamp };
  if (Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_MAX) throw invalid();
  return payload;
}

function phaseOf(value: unknown): MigrationView['phase'] {
  if (value !== 'preparing' && value !== 'prepared' && value !== 'active' && value !== 'rolled_back') throw invalid();
  return value;
}

function readinessOf(value: unknown): MigrationView['readiness'] {
  if (value !== 'pending' && value !== 'ready' && value !== 'signin' && value !== 'changed' && value !== 'unavailable') throw invalid();
  return value;
}

function authKindOf(value: unknown): MigrationView['auth'] {
  if (value !== null && value !== 'none' && value !== 'header' && value !== 'oauth') throw invalid();
  return value;
}

function nullableName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || connectorName(value) !== value) throw invalid();
  return value;
}

function nullableStamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid();
  deliveryBytes(value, 32);
  return value;
}

function viewOf(raw: unknown): MigrationView {
  const view = deliveryRecord(raw, ['operationId', 'sourceId', 'destinationId', 'phase', 'readiness', 'name', 'auth', 'policy', 'sourceStamp']);
  return { operationId: idOf(view.operationId), sourceId: idOf(view.sourceId), destinationId: idOf(view.destinationId), phase: phaseOf(view.phase), readiness: readinessOf(view.readiness), name: nullableName(view.name), auth: authKindOf(view.auth), policy: view.policy === null ? null : connectorPolicyOf(view.policy), sourceStamp: nullableStamp(view.sourceStamp) };
}

export function migrationResponseOf(raw: unknown): MigrationResponse {
  const value = deliveryRecord(raw, ['migration', 'receiving']);
  const migration = viewOf(value.migration);
  if (!Object.hasOwn(value, 'receiving')) return { migration };
  const receiving = deliveryRecord(value.receiving, ['publicKey', 'context']);
  if (typeof receiving.publicKey !== 'string' || sealingKeyOf(receiving.publicKey) === null) throw invalid();
  const context = contextOf(receiving.context);
  if (context.operationId !== migration.operationId || context.sourceId !== migration.sourceId || context.destinationId !== migration.destinationId) throw invalid();
  return { migration, receiving: { publicKey: receiving.publicKey, context } };
}

export function sealConnectorMigration(publicKey: string, context: MigrationContext, payload: MigrationPayload): SealedTransfer {
  return sealTransfer(publicKey, contextBytes(context), Buffer.from(JSON.stringify(migrationPayloadOf(payload))));
}

export function openConnectorMigration(privateKey: KeyObject, context: MigrationContext, sealed: unknown): MigrationPayload {
  if (Buffer.byteLength(JSON.stringify(sealed)) > CONNECTOR_MIGRATION_MAX_BYTES) throw invalid();
  const plain = openTransfer(privateKey, contextBytes(context), sealed, PAYLOAD_MAX);
  return migrationPayloadOf(JSON.parse(plain.toString('utf8')) as unknown);
}
