import { useCallback } from 'react';
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { fetchModel, syncModel, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { fetchGatewayWindows, withGatewayWindows, type GatewayWindow } from '@metro-labs/client/api/gateway-usage';
import type { ModelOption } from '@metro-labs/client/api/model-options';
import { fetchOrgModelList, fetchOrgModels, type OrgModels } from '@metro-labs/client/api/org-models';
import { orgKey, refresh, useBoxQuery } from './queries.js';
import { logError } from './log.js';

const LIST_MS = 10 * 60_000;
const STATUS_POLL_MS = 15_000;
const WINDOWS_POLL_MS = 30_000;
const NO_WINDOWS: GatewayWindow[] = [];

const useGatewayWindows = (poll: boolean): GatewayWindow[] =>
  useQuery({
    queryKey: orgKey('gateway-windows', String(accountScopeIdentity())),
    queryFn: ({ signal }) => fetchGatewayWindows(signal),
    staleTime: WINDOWS_POLL_MS,
    retry: false,
    refetchInterval: poll ? WINDOWS_POLL_MS : false,
  }).data ?? NO_WINDOWS;

export function useModelQuery(poll = true): UseQueryResult<ModelSettings> {
  const windows = useGatewayWindows(poll);
  const select = useCallback((settings: ModelSettings): ModelSettings => ({ ...settings, usage: withGatewayWindows(settings.usage, windows) }), [windows]);
  return useBoxQuery('model', fetchModel, { staleTime: 5_000, refetchInterval: poll ? STATUS_POLL_MS : false, select });
}

export const useOrgModelsQuery = (poll = false): UseQueryResult<OrgModels> =>
  useQuery({ queryKey: orgKey('org-models', String(accountScopeIdentity())), queryFn: fetchOrgModels, staleTime: 30_000, retry: false, refetchInterval: poll ? 3_000 : false });

export function useConnectionModelsQuery(connection: ConnectionRow | undefined): UseQueryResult<ModelOption[]> {
  const id = connection?.id ?? '';
  return useQuery({
    queryKey: orgKey('org-model-list', id),
    queryFn: ({ signal }) => fetchOrgModelList(id, signal),
    enabled: id !== '',
    staleTime: LIST_MS,
    retry: false,
  });
}

export async function syncSelectedBox(client: QueryClient): Promise<void> {
  if (currentServer() === null) return;
  await syncModel().catch(logError('model sync'));
  await refresh(client, 'model');
}

export async function afterModelChange(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: orgKey('org-models') });
  await syncSelectedBox(client);
}
