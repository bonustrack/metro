import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { decideRemoteApproval, type RemoteApproval } from '@metro-labs/client/api/agent-keys';
import type { Decision } from '@metro-labs/client/api/approvals';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { ApprovalCardView, type ApprovalContext } from '../home/ApprovalCard.js';
import { ErrorState } from '../ui/ErrorState.js';
import { queryError } from '../../lib/queries.js';
import { refreshRemoteApprovals, useRemoteApprovals } from '../../lib/remote-agents.js';

const CARD_GAP = 16;
const MARK = 24;

function Card({ agent, found }: { agent: string; found: RemoteApproval }): ReactNode {
  const client = useQueryClient();
  const context: ApprovalContext = { agentId: agent, groups: [], tools: {} };
  const decide = async (decision: Decision): Promise<void> => {
    await decideRemoteApproval(agent, found.approval.id, decision);
    await refreshRemoteApprovals(client, agent);
  };
  const name = found.connectorName ?? undefined;
  const mark = name === undefined ? undefined : <ConnectorFavicon name={name} url={found.connectorUrl ?? ''} size={MARK} />;
  return <ApprovalCardView approval={found.approval} context={context} decide={decide} where={name} mark={mark} />;
}

export function RemoteApprovals({ agent }: { agent: string }): ReactNode {
  const { data, error, refetch } = useRemoteApprovals(agent);
  const approvals = data ?? [];
  if (approvals.length === 0 && error === null) return null;
  return (
    <Col gap={CARD_GAP}>
      {error === null ? null : <ErrorState title="Could not check for new approvals" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />}
      {approvals.map((found) => (
        <Card key={found.approval.id} agent={agent} found={found} />
      ))}
    </Col>
  );
}
