import { useQueries, useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { fetchApprovals, type Approval } from '@metro-labs/client/api/approvals';
import { boxesOf, isRemote } from '@metro-labs/client/api/servers';
import { baseFromSegment, daemonBase } from '@metro-labs/client/auth/daemon';
import { useServersQuery, useServerStatuses } from './queries.js';
import { useRemoteApprovalLists } from './remote-agents.js';
import { useSharedPoll } from './shared-poll.js';

const WAITING_POLL_MS = 30_000;

const approvalsKey = (base: string): string[] => ['approvals', base];

const approvalsOptions = (base: string, enabled: boolean): UseQueryOptions<Approval[], Error, Approval[], string[]> => ({
  queryKey: approvalsKey(base),
  queryFn: () => fetchApprovals(base),
  enabled,
  staleTime: 15_000,
  retry: false,
});

export interface ApprovalRead {
  data?: Approval[] | undefined;
  error: unknown;
}

export function waitingCount(read: ApprovalRead | undefined, live: boolean): number | null {
  if (!live || read === undefined || read.error !== null || read.data === undefined) return null;
  return read.data.length;
}

export function useApprovalLists(hosts: string[], live: boolean[]): UseQueryResult<Approval[]>[] {
  const bases = hosts.map(baseFromSegment);
  useSharedPoll(bases.map(approvalsKey), WAITING_POLL_MS);
  return useQueries({ queries: bases.map((base, i) => approvalsOptions(base, live[i] === true)) });
}

export function useBoxApprovals(): UseQueryResult<Approval[]> {
  const base = daemonBase();
  useSharedPoll([approvalsKey(base)], WAITING_POLL_MS);
  return useQuery(approvalsOptions(base, true));
}

export function useWaitingTotal(): number {
  const servers = useServersQuery().data ?? [];
  const hosts = boxesOf(servers).map((s) => s.host);
  const live = useServerStatuses(hosts).map((status) => status.data?.state === 'live');
  const waiting = useApprovalLists(hosts, live);
  const remote = useRemoteApprovalLists(servers.filter(isRemote).map((s) => s.id));
  const onBoxes = waiting.reduce((sum, read, i) => sum + (waitingCount(read, live[i] === true) ?? 0), 0);
  return onBoxes + remote.reduce((sum, read) => sum + (read.error === null && read.data !== undefined ? read.data.length : 0), 0);
}
