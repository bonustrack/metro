import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import { decideRemoteApproval, type RemoteApproval } from '@metro-labs/client/api/agent-keys';
import { ApprovalScreen, type ApprovalSource } from '../approval/ApprovalPage.js';
import { ApprovalMark } from '../home/ApprovalCard.js';
import { RemoteMark } from './RemoteApprovals.js';
import { refreshRemoteApprovals, useRemoteApprovals } from '../../lib/remote-agents.js';

export function RemoteApprovalPage({ agent, id }: { agent: string; id: string }): ReactNode {
  const client = useQueryClient();
  const approvals = useRemoteApprovals(agent);
  const source: ApprovalSource<RemoteApproval> = {
    read: { data: approvals.data, error: approvals.error },
    retry: approvals.refetch,
    pick: (list) => list.find((one) => one.approval.id === id),
    show: (found) => {
      const card = approvalCard(found.approval);
      return { approval: found.approval, where: found.connectorName ?? card.connector, mark: found.connectorName === null ? <ApprovalMark card={card} /> : <RemoteMark found={found} /> };
    },
    send: (decision) => decideRemoteApproval(agent, id, decision),
    refresh: () => refreshRemoteApprovals(client, agent),
  };
  return <ApprovalScreen project={agent} source={source} />;
}
