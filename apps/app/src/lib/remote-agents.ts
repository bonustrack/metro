import { useQueries, useQuery, type QueryClient, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { fetchAgentKeys, fetchRemoteApprovals, type AgentKey, type RemoteApproval } from '@metro-labs/client/api/agent-keys';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { useOrgConnectorsQuery } from './org-connector-queries.js';
import { orgKey } from './queries.js';
import { useSharedPoll } from './shared-poll.js';

const APPROVALS_POLL_MS = 30_000;

const approvalsKey = (agent: string): string[] => orgKey('remote-approvals', String(accountScopeIdentity()), agent);

const keysKey = (agent: string): string[] => orgKey('agent-keys', String(accountScopeIdentity()), agent);

const approvalsOptions = (agent: string): UseQueryOptions<RemoteApproval[], Error, RemoteApproval[], string[]> => ({
  queryKey: approvalsKey(agent),
  queryFn: () => fetchRemoteApprovals(agent),
  staleTime: 15_000,
  retry: false,
});

export function useRemoteApprovalLists(agents: string[]): UseQueryResult<RemoteApproval[]>[] {
  useSharedPoll(agents.map(approvalsKey), APPROVALS_POLL_MS);
  return useQueries({ queries: agents.map(approvalsOptions) });
}

export function useRemoteApprovals(agent: string): UseQueryResult<RemoteApproval[]> {
  useSharedPoll([approvalsKey(agent)], APPROVALS_POLL_MS);
  return useQuery(approvalsOptions(agent));
}

export const refreshRemoteApprovals = (client: QueryClient, agent: string): Promise<void> => client.invalidateQueries({ queryKey: approvalsKey(agent) });

export const useAgentKeysQuery = (agent: string): UseQueryResult<AgentKey[]> =>
  useQuery({ queryKey: keysKey(agent), queryFn: () => fetchAgentKeys(agent), staleTime: 30_000, retry: false });

export const refreshAgentKeys = (client: QueryClient, agent: string): Promise<void> => client.invalidateQueries({ queryKey: keysKey(agent) });

export const assignedTo = (connectors: OrgConnector[] | undefined, agent: string): OrgConnector[] | undefined =>
  connectors?.filter((connector) => connector.agents.some((one) => one.id === agent));

export function useConnectorCounts(agents: string[]): (number | null)[] {
  const connectors = useOrgConnectorsQuery().data?.connectors;
  return agents.map((agent) => assignedTo(connectors, agent)?.length ?? null);
}
