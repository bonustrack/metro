import { connectorKeys } from '@metro-labs/core/connector-keys';

interface KeyedConnector {
  id: string;
  name: string;
  agents: { id: string }[];
}

export function connectorOfKey<T extends KeyedConnector>(connectors: T[], agent: string, key: string): T | undefined {
  const assigned = connectors.filter((connector) => connector.agents.some((row) => row.id === agent));
  const keys = connectorKeys(assigned);
  return assigned.find((connector) => keys.get(connector.id) === key);
}
