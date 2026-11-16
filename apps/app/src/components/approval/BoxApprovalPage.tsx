import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import { decideApproval, type Approval } from '@metro-labs/client/api/approvals';
import type { AccountGroup } from '@metro-labs/client/api/accounts';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { ApprovalMark } from '../home/ApprovalCard.js';
import { ApprovalScreen, type ApprovalShown, type ApprovalSource } from './ApprovalPage.js';
import { useBoxApprovals } from '../../lib/agent-status.js';
import { approvalWhere, namedConnector, type NamedConnector } from '../../lib/approval-note.js';
import { useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { refresh, useStationsQuery } from '../../lib/queries.js';

function shownOf(approval: Approval, groups: AccountGroup[] | undefined, connector: (key: string) => NamedConnector | null | undefined): ApprovalShown {
  const card = approvalCard(approval);
  const named = card.connector === null ? null : connector(card.connector);
  const waits = named === undefined || (card.station !== null && groups === undefined);
  return { approval, where: waits ? undefined : approvalWhere(card, groups ?? [], named), connector: named, mark: <ApprovalMark card={card} connector={named} /> };
}

export function BoxApprovalPage({ project, id }: { project: string; id: string }): ReactNode {
  const client = useQueryClient();
  const approvals = useBoxApprovals();
  const stations = useStationsQuery();
  const connectors = useOrgConnectorsQuery();
  const groups = stations.data?.groups ?? (stations.error === null ? undefined : []);
  const agent = currentServer()?.id ?? null;
  const source: ApprovalSource<Approval> = {
    read: { data: approvals.data, error: approvals.error },
    retry: approvals.refetch,
    pick: (list) => list.find((one) => one.id === id),
    show: (approval) => shownOf(approval, groups, (key) => namedConnector(key, agent, connectors)),
    send: (decision) => decideApproval(id, decision),
    refresh: () => refresh(client, 'approvals'),
  };
  return <ApprovalScreen project={project} source={source} />;
}
