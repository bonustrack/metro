import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { connectorName } from './connector-input.js';
import { connectorPolicyLayersOf, connectorPolicyOf, type ConnectorPolicy, type ConnectorPolicyLayers } from './connector-policy.js';
import { parsePublicConnectorUrl } from './connector-public-url.js';
import { isOrganizationId } from './workos-token.js';

export const CONNECTOR_DELIVERY_LEASE_MS = 90_000;
export const CONNECTOR_DELIVERY_MAX_BYTES = 1024 * 1024;
export const DELIVERY_PLAINTEXT_MAX = Math.floor((CONNECTOR_DELIVERY_MAX_BYTES - 1024) * 3 / 4);

export interface DeliveryContext {
  owner: string;
  agent: string;
  keyId: string;
  requestId: string;
}

export interface DeliveredConnector {
  id: string;
  name: string;
  url: string;
  auth: 'none' | 'header' | 'oauth';
  headers: Record<string, string>;
  policy: ConnectorPolicy;
  policyLayers?: ConnectorPolicyLayers;
  revision: string;
  state: 'ready' | 'signin' | 'unavailable';
  expiresAt?: number;
}

export interface DeliverySnapshot {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  connectors: DeliveredConnector[];
}

export function deliveryBytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid connector delivery encoding.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid connector delivery encoding.');
  return bytes;
}

export function deliveryRecord(value: unknown, fields: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new Error('Invalid connector delivery.');
  return value;
}

export function deliveryContextBytes(context: DeliveryContext): Buffer {
  const value = deliveryRecord(context, ['owner', 'agent', 'keyId', 'requestId']);
  if (typeof value.owner !== 'string' || !isOrganizationId(value.owner) || parseId(value.agent) === null) throw new Error('Invalid connector delivery context.');
  deliveryBytes(value.keyId, 32);
  deliveryBytes(value.requestId, 32);
  return Buffer.from(JSON.stringify(['metro-connector-delivery/v1', value.owner, value.agent, value.keyId, value.requestId]));
}

const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function headerValue(name: string, text: unknown, auth: DeliveredConnector['auth']): string {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name) || typeof text !== 'string' || !/^[\x20-\x7e]{1,16384}$/.test(text)) throw new Error('Invalid connector delivery headers.');
  if (auth === 'oauth' && (name !== 'Authorization' || !/^Bearer [\x21-\x7e]+$/.test(text))) throw new Error('Invalid connector delivery access token.');
  return text;
}

function headersOf(value: unknown, auth: DeliveredConnector['auth'], state: DeliveredConnector['state']): Record<string, string> {
  if (!isRecord(value)) throw new Error('Invalid connector delivery headers.');
  const entries = Object.entries(value);
  const expected = auth !== 'none' && state === 'ready' ? 1 : 0;
  if (entries.length !== expected) throw new Error('Invalid connector delivery headers.');
  const out: Record<string, string> = {};
  for (const [name, text] of entries) out[name] = headerValue(name, text, auth);
  return out;
}

function authenticationOf(value: unknown): DeliveredConnector['auth'] {
  if (value !== 'none' && value !== 'header' && value !== 'oauth') throw new Error('Invalid delivered connector authentication.');
  return value;
}

function stateOf(value: unknown, auth: DeliveredConnector['auth']): DeliveredConnector['state'] {
  if (value !== 'ready' && value !== 'signin' && value !== 'unavailable') throw new Error('Invalid delivered connector state.');
  if (value === 'signin' && auth !== 'oauth') throw new Error('Invalid delivered connector state.');
  return value;
}

function urlOf(value: unknown): string {
  parsePublicConnectorUrl(value);
  if (typeof value !== 'string') throw new Error('Invalid delivered connector URL.');
  return value;
}

function connectorOf(raw: unknown): DeliveredConnector {
  const value = deliveryRecord(raw, ['id', 'name', 'url', 'auth', 'headers', 'policy', 'policyLayers', 'revision', 'state', 'expiresAt']);
  const id = parseId(value.id);
  if (id === null || typeof value.name !== 'string' || connectorName(value.name) !== value.name) throw new Error('Invalid delivered connector.');
  const url = urlOf(value.url);
  const auth = authenticationOf(value.auth);
  const state = stateOf(value.state, auth);
  deliveryBytes(value.revision, 32);
  if (Object.hasOwn(value, 'expiresAt') && !timestamp(value.expiresAt)) throw new Error('Invalid delivered connector expiry.');
  return { id, name: value.name, url, auth, state, revision: String(value.revision), headers: headersOf(value.headers, auth, state), policy: connectorPolicyOf(value.policy), ...(Object.hasOwn(value, 'policyLayers') ? { policyLayers: connectorPolicyLayersOf(value.policyLayers) } : {}), ...(timestamp(value.expiresAt) ? { expiresAt: value.expiresAt } : {}) };
}

export function deliverySnapshotOf(raw: unknown): DeliverySnapshot {
  const value = deliveryRecord(raw, ['version', 'issuedAt', 'expiresAt', 'connectors']);
  if (value.version !== 1 || !timestamp(value.issuedAt) || !timestamp(value.expiresAt) || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > CONNECTOR_DELIVERY_LEASE_MS || !Array.isArray(value.connectors)) throw new Error('Invalid connector delivery snapshot.');
  const issuedAt = value.issuedAt;
  const connectors = value.connectors.map((entry: unknown) => connectorOf(entry));
  if (new Set(connectors.map((connector) => connector.id)).size !== connectors.length) throw new Error('Duplicate delivered connector.');
  if (connectors.some((connector) => connector.state === 'ready' && connector.expiresAt !== undefined && connector.expiresAt <= issuedAt)) throw new Error('Expired delivered connector.');
  const snapshot: DeliverySnapshot = { version: 1, issuedAt: value.issuedAt, expiresAt: value.expiresAt, connectors };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > DELIVERY_PLAINTEXT_MAX) throw new Error('Connector delivery is too large.');
  return snapshot;
}
