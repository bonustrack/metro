import { createHmac } from 'node:crypto';
import { combineConnectorPolicies, connectorPoliciesBlocked, connectorPolicyOf, type ConnectorPolicy, type ConnectorPolicyLayers, type DeliveredConnector } from '@metro-labs/http/connector-delivery';
import type { AssignedConnector } from '../db/connector-delivery.js';
import type { ConnectorRow } from '../db/connectors.js';
import { openConnectorSecret, type ConnectorSecret } from './model.js';

export const credentialRevision = (key: Buffer, row: ConnectorRow): string => createHmac('sha256', key).update(JSON.stringify(['metro-connector-credential/v1', row.owner, row.id, row.auth, row.authGeneration, row.secret])).digest('base64url');

export function deliveryPolicy(row: AssignedConnector): { policy: ConnectorPolicy; policyLayers: ConnectorPolicyLayers; valid: boolean; blocked: boolean } {
  try {
    const global: unknown = row.connector.policy === null ? {} : JSON.parse(row.connector.policy);
    const assignment: unknown = row.assignmentPolicy === null ? {} : JSON.parse(row.assignmentPolicy);
    const policyLayers = { organization: connectorPolicyOf(global), agent: connectorPolicyOf(assignment) };
    return { policy: combineConnectorPolicies(policyLayers.organization, policyLayers.agent), policyLayers, valid: true, blocked: connectorPoliciesBlocked(policyLayers) };
  } catch {
    const policy = { read: 'deny', write: 'deny' } as const;
    return { policy, policyLayers: { organization: policy, agent: policy }, valid: false, blocked: true };
  }
}

function deliveredOAuth(base: DeliveredConnector, secret: Extract<ConnectorSecret, { kind: 'oauth' }>, now: number): DeliveredConnector {
  if (secret.imported !== undefined && secret.imported.state !== 'owned') return { ...base, state: secret.imported.state === 'signin' ? 'signin' : 'unavailable' };
  const tokens = secret.tokens;
  if (tokens?.resource === undefined) return { ...base, state: 'signin' };
  if (tokens.expiresAt !== undefined && tokens.expiresAt <= now) return { ...base, state: tokens.refreshToken === undefined ? 'signin' : 'unavailable' };
  return { ...base, url: secret.targetUrl, state: 'ready', headers: { Authorization: `Bearer ${tokens.accessToken}` }, ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }) };
}

export function deliveredConnector(key: Buffer, assigned: AssignedConnector, now: number, failed: Map<string, string>, layered = false): DeliveredConnector {
  const row = assigned.connector;
  const { policy, policyLayers, valid, blocked } = deliveryPolicy(assigned);
  const revision = credentialRevision(key, row);
  const auth = row.auth === 'oauth' || row.auth === 'header' ? row.auth : 'none';
  const base: DeliveredConnector = { id: row.id, name: row.name, url: row.url, auth, policy: layered ? { read: 'deny', write: 'deny' } : policy, ...(layered ? { policyLayers } : {}), revision, state: 'unavailable', headers: {} };
  const denied = layered ? blocked : connectorPoliciesBlocked({ organization: policy, agent: {} });
  if (!valid || denied || failed.get(row.id) === revision) return base;
  return readyConnector(key, row, base, now);
}

function readyConnector(key: Buffer, row: ConnectorRow, base: DeliveredConnector, now: number): DeliveredConnector {
  try {
    const secret = openConnectorSecret(key, row);
    if (secret === null || secret.kind !== row.auth) return base;
    if (secret.kind === 'none') return { ...base, url: secret.targetUrl, state: 'ready' };
    if (secret.kind === 'header') return { ...base, url: secret.targetUrl, headers: { [secret.name]: secret.value }, state: 'ready' };
    return deliveredOAuth(base, secret, now);
  } catch {
    return base;
  }
}
