import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Permissions } from './Permissions.js';
import { fetchConnectorTools, setConnectorPolicy, type Connector } from '../api/connectors.js';
import { connectorToolGroups } from '../api/policy.js';
import { refresh, useBoxQuery } from '../api/queries.js';

export function ConnectorPermissions({ connector, title }: { connector: Connector; title: string }): ReactNode {
  const client = useQueryClient();
  const tools = useBoxQuery(['connector-tools', connector.id], () => fetchConnectorTools(connector.id), { staleTime: 60_000, retry: false });
  if (tools.data === undefined || tools.data.length === 0) return null;
  return (
    <Permissions
      title={title}
      policy={connector.policy}
      tools={connectorToolGroups(tools.data)}
      titles={Object.fromEntries(tools.data.map((tool) => [tool.name, tool.title]))}
      store={(next) => setConnectorPolicy(connector.id, next)}
      onSaved={() => refresh(client, ['connector', connector.id])}
    />
  );
}
