import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import { fetchModelUsage, type ModelUsage, type UsageQuery } from '@metro-labs/client/api/gateway-usage';
import { orgKey } from './queries.js';
import { useSharedPoll } from './shared-poll.js';

const USAGE_POLL_MS = 60_000;

export function useGatewayUsage(query: UsageQuery): UseQueryResult<ModelUsage | null> {
  const key = orgKey('gateway-usage', String(accountScopeIdentity()), query.range, query.agent ?? 'all', query.connection ?? 'all');
  useSharedPoll([key], USAGE_POLL_MS);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchModelUsage(query, signal),
    staleTime: USAGE_POLL_MS,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
