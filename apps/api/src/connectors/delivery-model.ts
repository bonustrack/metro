import { connectorPoliciesBlocked, type DeliveredConnector } from '@metro-labs/http/connector-delivery';
import type { AssignedConnector } from '@metro-labs/connectors/db/connector-delivery';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { openConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { credentialRevision, deliveryPolicy } from '@metro-labs/connectors/revision';

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
