import { useSyncExternalStore } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient, type UseInfiniteQueryResult, type UseQueryResult } from '@tanstack/react-query';
import { fetchOrgConnectorEvents, fetchOrgConnectors, type OrgConnectorEvents, type OrgConnectors, type OrgEventPage } from '@metro-labs/client/api/org-connectors';
import { orgKey } from './queries.js';

export const useOrgConnectorsQuery = (): UseQueryResult<OrgConnectors> =>
  useQuery({ queryKey: orgKey('org-connectors', String(accountScopeIdentity())), queryFn: fetchOrgConnectors, staleTime: 30_000, retry: false });

export const useOrgEventsQuery = (connector: string | null): UseInfiniteQueryResult<InfiniteData<OrgConnectorEvents, OrgEventPage | null>> =>
  useInfiniteQuery<OrgConnectorEvents, Error, InfiniteData<OrgConnectorEvents, OrgEventPage | null>, string[], OrgEventPage | null>({
    queryKey: orgKey('org-connector-events', String(accountScopeIdentity()), connector ?? 'all'),
    queryFn: ({ pageParam }) => fetchOrgConnectorEvents(connector, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
    staleTime: 15_000,
    retry: false,
  });

export async function refreshOrgConnectors(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: orgKey('org-connectors') });
  await client.invalidateQueries({ queryKey: orgKey('org-connector-events') });
}

export const useConnectorScope = (): number => useSyncExternalStore(subscribeAccountScope, accountScopeIdentity, accountScopeIdentity);
