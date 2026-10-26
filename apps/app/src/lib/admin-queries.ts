import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchAllAgents, fetchAllOrganizations, fetchOrganizationUsage, fetchUsers, type AgentRow, type OrganizationSummary, type UserRow } from '@metro-labs/client/api/admin';
import type { DashboardState } from '@metro-labs/client/api/dashboard';
import type { LatestUsage } from '@metro-labs/client/api/latest-usage';
import { duringUpdate } from '@metro-labs/client/api/servers';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { adminAgents, type AdminAgent } from './admin-agents.js';
import { useAllAgents } from './all-agents.js';
import { useMetroRelease } from './metro-release.js';
import { useSharedPoll } from './shared-poll.js';

const USAGE_POLL_MS = 60_000;

export const ADMIN_USERS_KEY = ['admin', 'users'];
export const ADMIN_AGENTS_KEY = ['admin', 'agents'];
const ADMIN_ORGANIZATIONS_KEY = ['admin', 'organizations'];

const usageKey = (organization: string): string[] => ['admin', 'usage', organization];

export const useAdminUsers = (): UseQueryResult<UserRow[]> => useQuery({ queryKey: ADMIN_USERS_KEY, queryFn: fetchUsers, staleTime: 15_000, retry: false });

export const useAdminOrganizations = (): UseQueryResult<OrganizationSummary[]> =>
  useQuery({ queryKey: ADMIN_ORGANIZATIONS_KEY, queryFn: fetchAllOrganizations, staleTime: 15_000, retry: false });

export const useEveryAgent = (): UseQueryResult<AgentRow[]> => useQuery({ queryKey: ADMIN_AGENTS_KEY, queryFn: fetchAllAgents, staleTime: 15_000, retry: false });

function useOrganizationUsage(organizations: string[]): Record<string, Record<string, LatestUsage> | undefined> {
  useSharedPoll(organizations.map(usageKey), USAGE_POLL_MS);
  const reads = useQueries({
    queries: organizations.map((organization) => ({ queryKey: usageKey(organization), queryFn: () => fetchOrganizationUsage(organization), staleTime: 30_000, retry: false })),
  });
  return Object.fromEntries(organizations.map((organization, at) => [organization, reads[at]?.data]));
}

const keepUpdating = (host: string, status: Parameters<typeof duringUpdate>[1]): ReturnType<typeof duringUpdate> => duringUpdate(baseFromSegment(host), status);

interface AdminAgentsView {
  rows: AdminAgent[];
  dashboard: DashboardState;
  everyAgent: UseQueryResult<AgentRow[]>;
  latest: string | null;
}

export function useAdminAgents(now: number): AdminAgentsView {
  const dashboard = useAllAgents();
  const everyAgent = useEveryAgent();
  const release = useMetroRelease();
  const organizations = (dashboard.organizations ?? []).map((organization) => organization.id);
  const usage = useOrganizationUsage(organizations);
  const latest = release.isError || release.data === undefined ? null : release.data.latest;
  const rows = adminAgents({ dashboard, everyAgent: everyAgent.data, usage, latest, now, updating: keepUpdating });
  return { rows, dashboard, everyAgent, latest };
}
