import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import { decideRemoteApproval, type RemoteApproval } from '@metro-labs/client/api/agent-keys';
import { ApprovalScreen, type ApprovalShown, type ApprovalSource } from '../approval/ApprovalPage.js';
import { ApprovalMark } from '../home/ApprovalCard.js';
import { remoteConnector } from '../../lib/approval-note.js';
import { refreshRemoteApprovals, useRemoteApprovals } from '../../lib/remote-agents.js';

function shownOf(found: RemoteApproval): ApprovalShown {
  const card = approvalCard(found.approval);
  const named = remoteConnector(found);
  return { approval: found.approval, where: named?.name ?? card.connector, connector: named, mark: <ApprovalMark card={card} connector={named} /> };
}

export function RemoteApprovalPage({ agent, id }: { agent: string; id: string }): ReactNode {
  const client = useQueryClient();
  const approvals = useRemoteApprovals(agent);
  const source: ApprovalSource<RemoteApproval> = {
    read: { data: approvals.data, error: approvals.error },
    retry: approvals.refetch,
    pick: (list) => list.find((one) => one.approval.id === id),
    show: shownOf,
    send: (decision) => decideRemoteApproval(agent, id, decision),
    refresh: () => refreshRemoteApprovals(client, agent),
  };
  return <ApprovalScreen project={agent} source={source} />;
}
