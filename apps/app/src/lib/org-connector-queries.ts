import { useSyncExternalStore } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchOrgConnectorTools, fetchOrgConnectors, type OrgConnectors } from '@metro-labs/client/api/org-connectors';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
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

export async function refreshOrgConnectors(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: orgKey('org-connectors') });
}

export const useConnectorScope = (): number => useSyncExternalStore(subscribeAccountScope, accountScopeIdentity, accountScopeIdentity);
