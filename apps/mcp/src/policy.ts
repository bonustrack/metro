import { decideTool, effectiveConnectorPolicy, type ConnectorPolicy } from '@metro-labs/http/connector-policy';
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

export function connectorAccess(assigned: AssignedConnector): ConnectorAccess {
  const { policy, policyLayers, valid, blocked } = deliveryPolicy(assigned);
  if (!valid || blocked) return { blocked: true, decide: () => 'deny', needsGroup: () => false };
  const row = { policy, policyLayers };
  const decide = (tool: string, groups: Record<string, ToolGroup>): ConnectorDecision => {
    const group = groupOf(groups, tool);
    return decideTool(effectiveConnectorPolicy(row, { [tool]: group }), tool, group);
  };
  return {
    blocked: false,
    decide,
    needsGroup: (tool) => decide(tool, { [tool]: 'read' }) !== decide(tool, {}),
  };
}
