import { useSyncExternalStore } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { useQueries, useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchOrgConnectorTools, fetchOrgConnectors, type OrgConnector, type OrgConnectors } from '@metro-labs/client/api/org-connectors';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import { orgKey } from './queries.js';
import { useSharedPoll } from './shared-poll.js';

const connectorsKey = (): string[] => orgKey('org-connectors', String(accountScopeIdentity()));

export const useOrgConnectorsQuery = (pollMs?: number, enabled = true): UseQueryResult<OrgConnectors> =>
  useQuery({ queryKey: connectorsKey(), queryFn: fetchOrgConnectors, staleTime: 30_000, retry: false, refetchInterval: pollMs ?? false, enabled });

export function useOrgConnectorsPoll(every: number | null): void {
  useSharedPoll(every === null ? [] : [connectorsKey()], every ?? 0);
}

export const toolsKey = (connector: Pick<OrgConnector, 'id' | 'verifiedAt'>): string[] =>
  orgKey('org-connector-tools', String(accountScopeIdentity()), connector.id, connector.verifiedAt ?? '');

type ToolsOf = Pick<OrgConnector, 'id' | 'verifiedAt'>;

const NO_CONNECTOR: ToolsOf = { id: '', verifiedAt: null };

const toolsQuery = (connector: ToolsOf, enabled = true) => ({
  queryKey: toolsKey(connector),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchOrgConnectorTools(connector.id, signal),
  staleTime: 60_000,
  retry: false,
  enabled,
});

export const useOrgConnectorToolsQuery = (connector: ToolsOf): UseQueryResult<ConnectorTool[]> => useQuery(toolsQuery(connector));

export const useOrgConnectorToolLists = (connectors: (ToolsOf | null)[]): UseQueryResult<ConnectorTool[]>[] =>
  useQueries({ queries: connectors.map((connector) => toolsQuery(connector ?? NO_CONNECTOR, connector !== null)) });

export async function refreshOrgConnectors(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: orgKey('org-connectors') });
}

export const useConnectorScope = (): number => useSyncExternalStore(subscribeAccountScope, accountScopeIdentity, accountScopeIdentity);
