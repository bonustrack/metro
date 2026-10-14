import { effectiveConnectorPolicy, type ConnectorPolicy } from '@metro-labs/http/connector-delivery';
import type { AssignedConnector } from '@metro-labs/connectors/db/connector-delivery';
import { deliveryPolicy } from '@metro-labs/connectors/revision';

export type ToolGroup = 'read' | 'write';

export type ConnectorDecision = NonNullable<ConnectorPolicy['read']>;

export interface ConnectorAccess {
  blocked: boolean;
  decide: (tool: string, groups: Record<string, ToolGroup>) => ConnectorDecision;
  needsGroup: (tool: string) => boolean;
}

const groupOf = (groups: Record<string, ToolGroup>, tool: string): ToolGroup => (Object.hasOwn(groups, tool) && groups[tool] === 'read' ? 'read' : 'write');

function decision(policy: ConnectorPolicy, tool: string, group: ToolGroup): ConnectorDecision {
  const named = policy.tools !== undefined && Object.hasOwn(policy.tools, tool) ? policy.tools[tool] : undefined;
  return named ?? policy[group] ?? 'allow';
}

export function connectorAccess(assigned: AssignedConnector): ConnectorAccess {
  const { policy, policyLayers, valid, blocked } = deliveryPolicy(assigned);
  if (!valid || blocked) return { blocked: true, decide: () => 'deny', needsGroup: () => false };
  const row = { policy, policyLayers };
  const decide = (tool: string, groups: Record<string, ToolGroup>): ConnectorDecision => {
    const group = groupOf(groups, tool);
    return decision(effectiveConnectorPolicy(row, { [tool]: group }), tool, group);
  };
  return {
    blocked: false,
    decide,
    needsGroup: (tool) => decide(tool, { [tool]: 'read' }) !== decide(tool, {}),
  };
}
