import { useQueries, type UseQueryOptions } from '@tanstack/react-query';
import { fetchApprovals, type Approval } from '@metro-labs/client/api/approvals';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { serverStatusOptions, useServersQuery } from './queries.js';

const WAITING_POLL_MS = 30_000;

export const approvalsOptions = (host: string, live: boolean): UseQueryOptions<Approval[], Error, Approval[], string[]> => ({
  queryKey: ['approvals', baseFromSegment(host)],
  queryFn: () => fetchApprovals(baseFromSegment(host)),
  enabled: live,
  staleTime: 15_000,
  refetchInterval: (query) => (query.state.error === null ? WAITING_POLL_MS : false),
  retry: false,
});

export function useWaitingTotal(): number {
  const { data: servers } = useServersQuery();
  const hosts = (servers ?? []).map((s) => s.host);
  const statuses = useQueries({ queries: hosts.map(serverStatusOptions) });
  const waiting = useQueries({ queries: hosts.map((host, i) => approvalsOptions(host, statuses[i]?.data?.state === 'live')) });
  return waiting.reduce((sum, q) => sum + (q.data?.length ?? 0), 0);
}
