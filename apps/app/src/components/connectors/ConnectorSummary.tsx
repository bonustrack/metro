import { type ReactNode } from 'react';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Summary } from '../ui/Summary.js';
import { connectorSummary } from '../../lib/connector-summary.js';
import { useChatApprovals } from '../../lib/chat-approvals.js';
import { useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';

interface ConnectorSummaryProps {
  connector: OrgConnector;
  agentId: string;
  name: string;
  remote: boolean;
}

export function ConnectorSummary({ connector, agentId, name, remote }: ConnectorSummaryProps): ReactNode {
  const tools = useOrgConnectorToolsQuery(connector).data;
  const chatApprovals = useChatApprovals();
  return <Summary segments={connectorSummary({ agent: name, agentId, connector, tools: tools ?? null, remote, chatApprovals })} />;
}
