import { createHmac } from 'node:crypto';
import { combineConnectorPolicies, connectorPolicyOf, type ConnectorPolicy, type DeliveredConnector } from '@metro-labs/http/connector-delivery';
import type { AssignedConnector } from '../db/connector-delivery.js';
import type { ConnectorRow } from '../db/connectors.js';
import { openConnectorSecret, type ConnectorSecret } from './model.js';

export const credentialRevision = (key: Buffer, row: ConnectorRow): string => createHmac('sha256', key).update(JSON.stringify(['metro-connector-credential/v1', row.owner, row.id, row.auth, row.authGeneration, row.secret])).digest('base64url');

export function deliveryPolicy(row: AssignedConnector): { policy: ConnectorPolicy; valid: boolean } {
  try {
    const global: unknown = row.connector.policy === null ? {} : JSON.parse(row.connector.policy);
    const assignment: unknown = row.assignmentPolicy === null ? {} : JSON.parse(row.assignmentPolicy);
    return { policy: combineConnectorPolicies(connectorPolicyOf(global), connectorPolicyOf(assignment)), valid: true };
  } catch {
    return { policy: { read: 'deny', write: 'deny' }, valid: false };
  }
}

function deliveredOAuth(base: DeliveredConnector, secret: Extract<ConnectorSecret, { kind: 'oauth' }>, now: number): DeliveredConnector {
  if (secret.imported !== undefined && secret.imported.state !== 'owned') return { ...base, state: secret.imported.state === 'signin' ? 'signin' : 'unavailable' };
  const tokens = secret.tokens;
  if (tokens?.resource === undefined) return { ...base, state: 'signin' };
  if (tokens.expiresAt !== undefined && tokens.expiresAt <= now) return { ...base, state: tokens.refreshToken === undefined ? 'signin' : 'unavailable' };
  return { ...base, url: secret.targetUrl, state: 'ready', headers: { Authorization: `Bearer ${tokens.accessToken}` }, ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }) };
}

export function deliveredConnector(key: Buffer, assigned: AssignedConnector, now: number, failed: Map<string, string>): DeliveredConnector {
  const row = assigned.connector;
  const { policy, valid } = deliveryPolicy(assigned);
  const revision = credentialRevision(key, row);
  const auth = row.auth === 'oauth' || row.auth === 'header' ? row.auth : 'none';
  const base: DeliveredConnector = { id: row.id, name: row.name, url: row.url, auth, policy, revision, state: 'unavailable', headers: {} };
  if (!valid || (policy.read === 'deny' && policy.write === 'deny' && Object.values(policy.tools ?? {}).every((rule) => rule === 'deny')) || failed.get(row.id) === revision) return base;
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
