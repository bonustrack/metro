import { connectorKeys } from '@metro-labs/connectors/connector-keys';
import type { AssignedConnector, DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { McpDeps } from './deps.js';
import { connectorAccess, type ConnectorAccess } from './policy.js';

export interface AgentConnector {
  id: string;
  key: string;
  name: string;
  assigned: AssignedConnector;
  access: ConnectorAccess;
}

export async function agentConnectors(deps: Pick<McpDeps, 'store'>, identity: DeliveryIdentity): Promise<AgentConnector[]> {
  const rows = await deps.store.assigned(identity);
  const keys = connectorKeys(rows.map((row) => ({ id: row.connector.id, name: row.connector.name })));
  return rows
    .map((row) => ({ id: row.connector.id, key: keys.get(row.connector.id) ?? row.connector.id, name: row.connector.name, assigned: row, access: connectorAccess(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

export const visibleKeys = (connectors: AgentConnector[]): string[] => connectors.filter((connector) => !connector.access.blocked).map((connector) => connector.key);

export function connectorsSentence(connectors: AgentConnector[]): string {
  const keys = visibleKeys(connectors);
  return keys.length === 0 ? 'This agent has no connectors it may use.' : `This agent's connectors: ${keys.join(', ')}.`;
}
