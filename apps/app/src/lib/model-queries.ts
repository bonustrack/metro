import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { fetchClaudeAccount } from '@metro-labs/client/api/claude';
import { claudeModels, fetchModel, syncModel, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import type { ModelOption } from '@metro-labs/client/api/model-options';
import { isLocal } from '@metro-labs/client/api/model-route';
import { fetchOrgModelList, fetchOrgModels, type OrgModels } from '@metro-labs/client/api/org-models';
import { usesSessionLogin } from '@metro-labs/client/api/providers';
import { boxKey, orgKey, refresh, useBoxQuery } from './queries.js';
import { logError } from './log.js';

const LIST_MS = 10 * 60_000;
const STATUS_POLL_MS = 15_000;

export const useModelQuery = (): UseQueryResult<ModelSettings> =>
  useBoxQuery('model', fetchModel, { staleTime: 5_000, refetchInterval: STATUS_POLL_MS });

export const useOrgModelsQuery = (poll = false): UseQueryResult<OrgModels> =>
  useQuery({ queryKey: orgKey('org-models', String(accountScopeIdentity())), queryFn: fetchOrgModels, staleTime: 30_000, retry: false, refetchInterval: poll ? 3_000 : false });

export function useConnectionModelsQuery(connection: ConnectionRow | undefined): UseQueryResult<ModelOption[]> {
  const id = connection?.id ?? '';
  const local = isLocal(id);
  return useQuery({
    queryKey: local ? boxKey(['connection-models', 'claude']) : orgKey('org-model-list', id),
    queryFn: ({ signal }) => (local ? claudeModels() : fetchOrgModelList(id, signal)),
    enabled: id !== '',
    staleTime: LIST_MS,
    retry: false,
  });
}

export function useAccountOf(conn: ConnectionRow | undefined): string | null {
  const session = conn === undefined || usesSessionLogin(conn);
  const account = useBoxQuery('claude-account', fetchClaudeAccount, { staleTime: 5_000, refetchInterval: STATUS_POLL_MS, enabled: session });
  const login = session && account.error === null ? (account.data?.account ?? null) : null;
  return login ?? conn?.account ?? null;
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
