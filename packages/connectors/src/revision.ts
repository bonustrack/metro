import { createHmac } from 'node:crypto';
import { combineConnectorPolicies, connectorPoliciesBlocked, connectorPolicyOf, type ConnectorPolicy, type ConnectorPolicyLayers } from '@metro-labs/http/connector-policy';
import type { AssignedConnector } from './db/connector-delivery.js';
import type { ConnectorRow } from './db/connectors.js';

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
