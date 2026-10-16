import { currentServer } from '@metro-labs/client/auth/daemon';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { useOrgConnectorsQuery } from '../lib/org-connector-queries.js';

interface AssignedConnectors {
  connectors: OrgConnector[] | undefined;
  admin: boolean;
  error: Error | null;
}

export function useAssignedConnectors(): AssignedConnectors {
  const agentId = currentServer()?.id;
  const { data, error } = useOrgConnectorsQuery();
  return {
    connectors: data?.connectors.filter((connector) => connector.agents.some((agent) => agent.id === agentId)),
    admin: data?.admin === true,
    error,
  };
}
