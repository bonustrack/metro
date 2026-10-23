import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import {
  ACTIVITY_LIVE_MAX, ACTIVITY_PAGE, emptyFeed, feedReducer, feedSince, fetchConnectorActivity, oldestCall, type ActivityCall,
} from '@metro-labs/client/api/connector-activity';
import { orgKey, queryError } from './queries.js';
import { usePageAtTop } from './page-scroll.js';
import { useSharedPoll } from './shared-poll.js';

const LIVE_POLL_MS = 3_000;
const LATEST_SHOWN = 10;

export interface ActivityFeedView {
  calls: ActivityCall[];
  waiting: number;
  loaded: boolean;
  error: string | null;
  retry: () => Promise<unknown>;
  complete: boolean;
  earlier: { busy: boolean; error: string | null; load: () => void };
}

export interface CallFilter {
  agent: string | null;
  connector: string | null;
}

function useEarlier(filter: CallFilter, oldest: ActivityCall | undefined, done: (calls: ActivityCall[] | null) => void): ActivityFeedView['earlier'] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (): void => {
    if (busy || oldest === undefined) return;
    setBusy(true);
    setError(null);
    fetchConnectorActivity({ before: oldest, limit: ACTIVITY_PAGE, ...filter })
      .then(done)
      .catch((err: unknown) => { setError(queryError(err, 'Could not load earlier calls.')); })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, load };
}

export function useFreshIds(calls: ActivityCall[], loaded: boolean): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const newest = useRef(0);
  const fresh = new Set(known.current === null ? [] : calls.filter((call) => !known.current?.has(call.id) && call.at >= newest.current).map((call) => call.id));
  useEffect(() => {
    if (!loaded) return;
    known.current = new Set(calls.map((call) => call.id));
    newest.current = Math.max(newest.current, ...calls.map((call) => call.at));
  }, [calls, loaded]);
  return fresh;
}

export function useLatestActivity(filter: CallFilter): UseQueryResult<ActivityCall[] | null> {
  const key = orgKey('connector-activity', String(accountScopeIdentity()), filter.agent ?? 'all', filter.connector ?? 'all', `latest-${String(LATEST_SHOWN)}`);
  useSharedPoll([key], LIVE_POLL_MS);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchConnectorActivity({ limit: LATEST_SHOWN, ...filter }, signal),
    staleTime: LIVE_POLL_MS,
    retry: false,
  });
}

export function useActivityFeed(filter: CallFilter): ActivityFeedView {
  const mount = useId();
  const [feed, dispatch] = useReducer(feedReducer, undefined, emptyFeed);
  const since = useRef<number | undefined>(undefined);
  since.current = feedSince(feed);
  const key = orgKey('connector-activity', String(accountScopeIdentity()), filter.agent ?? 'all', filter.connector ?? 'all', mount);
  useSharedPoll([key], LIVE_POLL_MS);
  const live = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchConnectorActivity({ since: since.current, limit: since.current === undefined ? ACTIVITY_PAGE : ACTIVITY_LIVE_MAX, ...filter }, signal),
    gcTime: 0,
    staleTime: LIVE_POLL_MS,
    retry: false,
  });
  useEffect(() => {
    if (live.data !== undefined) dispatch({ type: 'newer', calls: live.data });
  }, [live.data, live.dataUpdatedAt]);
  const atTop = usePageAtTop();
  useEffect(() => {
    dispatch({ type: 'hold', held: !atTop });
  }, [atTop]);
  const earlier = useEarlier(filter, oldestCall(feed), (calls) => { dispatch({ type: 'older', calls, asked: ACTIVITY_PAGE }); });
  const failed = feed.loaded || live.error === null ? null : queryError(live.error, 'Metro did not answer.');
  return {
    calls: feed.calls,
    waiting: feed.pending.length,
    loaded: feed.loaded,
    error: failed,
    retry: () => live.refetch(),
    complete: feed.complete,
    earlier,
  };
}
