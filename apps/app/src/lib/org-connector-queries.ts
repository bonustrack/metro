import { useSyncExternalStore } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchOrgConnectorTools, fetchOrgConnectors, type OrgConnectors } from '@metro-labs/client/api/org-connectors';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import { orgKey } from './queries.js';

export const useOrgConnectorsQuery = (): UseQueryResult<OrgConnectors> =>
  useQuery({ queryKey: orgKey('org-connectors', String(accountScopeIdentity())), queryFn: fetchOrgConnectors, staleTime: 30_000, retry: false });

export const useOrgConnectorToolsQuery = (id: string): UseQueryResult<ConnectorTool[]> =>
  useQuery({ queryKey: orgKey('org-connector-tools', String(accountScopeIdentity()), id), queryFn: ({ signal }) => fetchOrgConnectorTools(id, signal), staleTime: 60_000, retry: false });

export async function refreshOrgConnectors(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: orgKey('org-connectors') });
}

export const useConnectorScope = (): number => useSyncExternalStore(subscribeAccountScope, accountScopeIdentity, accountScopeIdentity);
