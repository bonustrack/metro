import { useSyncExternalStore } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { useQueries, useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchOrgConnectorListing, fetchOrgConnectorTools, fetchOrgConnectors, type OrgConnector, type OrgConnectors } from '@metro-labs/client/api/org-connectors';
import type { ConnectorListing, ConnectorTool } from '@metro-labs/client/api/connectors';
import { orgKey } from './queries.js';
import { useSharedPoll } from './shared-poll.js';

const connectorsKey = (): string[] => orgKey('org-connectors', String(accountScopeIdentity()));

export const useOrgConnectorsQuery = (pollMs?: number): UseQueryResult<OrgConnectors> =>
  useQuery({ queryKey: connectorsKey(), queryFn: fetchOrgConnectors, staleTime: 30_000, retry: false, refetchInterval: pollMs ?? false });

export function useOrgConnectorsPoll(every: number | null): void {
  useSharedPoll(every === null ? [] : [connectorsKey()], every ?? 0);
}

export const useOrgConnectorToolsQuery = (id: string): UseQueryResult<ConnectorTool[]> =>
  useQuery({ queryKey: orgKey('org-connector-tools', String(accountScopeIdentity()), id), queryFn: ({ signal }) => fetchOrgConnectorTools(id, signal), staleTime: 60_000, retry: false });

export const useConnectorListings = (connectors: readonly OrgConnector[]): UseQueryResult<ConnectorListing>[] =>
  useQueries({
    queries: connectors.map((connector) => ({
      queryKey: orgKey('org-connector-listing', String(accountScopeIdentity()), connector.id, connector.verifiedAt ?? ''),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchOrgConnectorListing(connector.id, signal),
      staleTime: 60_000,
      retry: false,
    })),
  });

export async function refreshOrgConnectors(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: orgKey('org-connectors') });
}

export const useConnectorScope = (): number => useSyncExternalStore(subscribeAccountScope, accountScopeIdentity, accountScopeIdentity);
