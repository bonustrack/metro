import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import { decideApproval, type Approval } from '@metro-labs/client/api/approvals';
import type { AccountGroup } from '@metro-labs/client/api/accounts';
import { ApprovalMark } from '../home/ApprovalCard.js';
import { ApprovalScreen, type ApprovalShown, type ApprovalSource } from './ApprovalPage.js';
import { useBoxApprovals } from '../../lib/agent-status.js';
import { approvalWhere } from '../../lib/approval-note.js';
import { refresh, useStationsQuery } from '../../lib/queries.js';

function shownOf(approval: Approval, groups: AccountGroup[] | undefined): ApprovalShown {
  const card = approvalCard(approval);
  const where = card.station !== null && groups === undefined ? undefined : approvalWhere(card, groups ?? []);
  return { approval, where, mark: <ApprovalMark card={card} /> };
}

export function BoxApprovalPage({ project, id }: { project: string; id: string }): ReactNode {
  const client = useQueryClient();
  const approvals = useBoxApprovals();
  const stations = useStationsQuery();
  const groups = stations.data?.groups ?? (stations.error === null ? undefined : []);
  const source: ApprovalSource<Approval> = {
    read: { data: approvals.data, error: approvals.error },
    retry: approvals.refetch,
    pick: (list) => list.find((one) => one.id === id),
    show: (approval) => shownOf(approval, groups),
    send: (decision) => decideApproval(id, decision),
    refresh: () => refresh(client, 'approvals'),
  };
  return <ApprovalScreen project={project} source={source} />;
}
