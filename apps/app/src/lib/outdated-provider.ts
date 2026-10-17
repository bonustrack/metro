import { providerTooNew, type ProviderInfo } from '@metro-labs/client/api/model';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { useOrgModelsQuery } from './model-queries.js';
import { useModeQuery } from './queries.js';

export function useOutdatedProvider(): ProviderInfo | null {
  const org = useOrgModelsQuery().data;
  const version = useModeQuery().data?.version ?? null;
  const agent = currentServer()?.id ?? null;
  if (org === undefined || agent === null) return null;
  return providerTooNew(org.agents[agent] ?? org.default, org.connections, version);
}

export const outdatedLine = (info: ProviderInfo): string => `Update Metro to use ${info.label}: open Settings, then Metro version under Server.`;
