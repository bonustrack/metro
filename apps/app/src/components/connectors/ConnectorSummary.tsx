import { type ReactNode } from 'react';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Summary } from '../ui/Summary.js';
import { connectorSummary } from '../../lib/connector-summary.js';
import { useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';

interface ConnectorSummaryProps {
  connector: OrgConnector;
  agentId: string;
  name: string;
  remote: boolean;
}

export function ConnectorSummary({ connector, agentId, name, remote }: ConnectorSummaryProps): ReactNode {
  const tools = useOrgConnectorToolsQuery(connector.id).data;
  return <Summary text={connectorSummary({ agent: name, agentId, connector, tools: tools ?? null, remote })} />;
}
