import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { PageTitle } from './PageTitle.js';
import { SignupChart } from './SignupChart.js';
import { AdminAws } from './AdminAws.js';
import { fetchAllAgents, fetchAllOrganizations, fetchUsers, type UserRow } from '@metro-labs/client/api/admin';
import { queryError } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const WIDTH = 760;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CARD_MIN = 150;

function sinceWeek(rows: { at: string | null }[], now: number): number {
  return rows.filter((r) => r.at !== null && now - Date.parse(r.at) < WEEK_MS).length;
}

function Stat({ label, total, week, waiting }: { label: string; total: number; week: number; waiting?: number }): ReactNode {
  const side = { width: 1, color: useKitPalette().border };
  return (
    <Col flex={1} minWidth={CARD_MIN} gap={4} padding={16} radius={12} border={{ top: side, right: side, bottom: side, left: side }}>
      <Text size="2xs" role="secondary">
        {label}
      </Text>
      <Text size="2xl" weight="semibold">
        {String(total)}
      </Text>
      <Text size="2xs" role="secondary">
        {`+${String(week)} in the last 7 days`}
      </Text>
      {waiting === undefined ? null : (
        <Text size="2xs" role={waiting > 0 ? 'danger' : 'secondary'}>
          {`${String(waiting)} waiting`}
        </Text>
      )}
    </Col>
  );
}

interface Counts {
  users: number;
  usersWeek: number;
  waiting: number;
  organizations: number;
  organizationsWeek: number;
  agents: number;
  agentsWeek: number;
}

function useCounts(): { counts: Counts; error: Error | null; users: UserRow[] | undefined } {
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: fetchUsers, staleTime: 15_000, retry: false });
  const organizations = useQuery({ queryKey: ['admin', 'organizations'], queryFn: fetchAllOrganizations, staleTime: 15_000, retry: false });
  const agents = useQuery({ queryKey: ['admin', 'agents'], queryFn: fetchAllAgents, staleTime: 15_000, retry: false });
  const now = Date.now();
  const u = users.data ?? [];
  const o = organizations.data ?? [];
  const a = agents.data ?? [];
  return {
    users: users.data,
    error: users.error ?? organizations.error ?? agents.error,
    counts: {
      users: u.length,
      usersWeek: sinceWeek(u.map((x) => ({ at: x.createdAt })), now),
      waiting: u.filter((x) => x.status === 'waitlist').length,
      organizations: o.length,
      organizationsWeek: sinceWeek(o.map((x) => ({ at: x.createdAt })), now),
      agents: a.length,
      agentsWeek: sinceWeek(a.map((x) => ({ at: x.addedAt })), now),
    },
  };
}

export function AdminOverview(): ReactNode {
  useDocumentTitle('Admin');
  const { counts, error, users } = useCounts();
  return (
    <Col gap={20} width="100%" maxWidth={WIDTH}>
      <PageTitle>Admin</PageTitle>
      {error === null ? null : (
        <Text size="2xs" role="danger">
          {queryError(error, 'Could not load the numbers.')}
        </Text>
      )}
      <Row gap={12} wrap>
        <Stat label="Users" total={counts.users} week={counts.usersWeek} waiting={counts.waiting} />
        <Stat label="Organizations" total={counts.organizations} week={counts.organizationsWeek} />
        <Stat label="Agents" total={counts.agents} week={counts.agentsWeek} />
      </Row>
      {users === undefined ? null : <SignupChart users={users} />}
      <AdminAws />
    </Col>
  );
}
