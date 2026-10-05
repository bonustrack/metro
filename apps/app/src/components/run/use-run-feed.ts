import { useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { getRunEvents, RUN_EVENTS_SINCE } from '@metro-labs/client/api/run-events';
import { olderThan } from '@metro-labs/client/api/version';
import { boxKey, useBoxQuery, type BoxKey } from '../../lib/queries.js';
import { mergeRunFeed, type RetainedRunFeed } from './metro-entries.js';

export async function fetchRunFeed(client: QueryClient, cacheKey: string[], agentId: string, version: string | null): Promise<RetainedRunFeed> {
  const previous = client.getQueryData<RetainedRunFeed>(cacheKey);
  const cursor = previous?.cursor === '' ? undefined : previous?.cursor;
  const page = await getRunEvents(agentId, { cursor, limit: cursor === undefined ? 500 : 100, version });
  if (!page.reset || cursor === undefined) return mergeRunFeed(previous, page);
  if (client.getQueryData(cacheKey) !== previous) throw new Error('Run events changed while loading.');
  const cleared = mergeRunFeed(previous, { ...page, events: [], cursor: '', hasMore: false });
  client.setQueryData(cacheKey, cleared);
  return mergeRunFeed(cleared, await getRunEvents(agentId, { limit: 500, version }));
}

export function useRunFeed(agentId: string, version: string | null, ready: boolean): UseQueryResult<RetainedRunFeed> {
  const client = useQueryClient();
  const key: BoxKey = ['run-events', agentId];
  const cacheKey = boxKey(key);
  return useBoxQuery(key, () => fetchRunFeed(client, cacheKey, agentId, version), {
    enabled: ready && !olderThan(version, RUN_EVENTS_SINCE), staleTime: 0, gcTime: 0, retry: false,
    refetchOnMount: 'always', refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data?.hasMore === true && query.state.error === null ? 100 : 5_000,
  });
}
