import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import { fetchConnectorStats, type ConnectorStats, type StatsQuery } from '@metro-labs/client/api/connector-stats';
import { useOrgConnectorsQuery } from './org-connector-queries.js';
import { orgKey } from './queries.js';
import { useSharedPoll } from './shared-poll.js';

const STATS_POLL_MS = 60_000;

export function useConnectorStats(query: StatsQuery): UseQueryResult<ConnectorStats | null> {
  const key = orgKey('connector-stats', String(accountScopeIdentity()), query.range, query.agent ?? 'all', query.connector ?? 'all');
  useSharedPoll([key], STATS_POLL_MS);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchConnectorStats(query, signal),
    staleTime: STATS_POLL_MS,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

const byAge = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function useConnectorOrder(): string[] {
  const connectors = useOrgConnectorsQuery().data?.connectors ?? [];
  return [...connectors].sort(byAge).map((connector) => connector.id);
}
