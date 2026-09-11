import { daemonBase } from '../auth/daemon.js';
import {
  QueryCache,
  QueryClient,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { carryForward, type AccountGroup } from './accounts.js';
import {
  AuthError,
  StoppedError,
  fetchSession,
  fetchStations,
  type StationsView,
} from './client.js';
import {
  fetchConnector,
  fetchConnectors,
  type Connector,
  type ConnectorsView,
} from './connectors.js';
import {
  fetchClaudeProjects,
  fetchClaudeSessions,
  fetchClaudeSettings,
  fetchClaudeSkill,
  fetchClaudeSkills,
  fetchMemory,
  fetchMemoryFile,
  deleteClaudeSession,
  type ClaudeProject,
  type ClaudeSession,
  type ClaudeSettingsFile,
  type ClaudeSkill,
  type SkillListing,
  type MemoryListing,
} from './claude.js';
import { fetchClaudeSession, fetchClaudeSetup, type ClaudeSessionStatus, type ClaudeSetup } from './claude-box.js';
import { fetchMode, type ModeInfo } from './mode.js';
import { fetchUpdate, type UpdateCheck } from './update.js';
import { fetchServers, probeServer, type Server, type ServerStatus } from './servers.js';
import { fetchMachine, type Machine } from './machine.js';
import { codexModels, fetchModel, openrouterModels, type ModelOption, type ModelSettings } from './model.js';

const STALE_MS = 60_000;
const STARTING_POLL_MS = 3_000;
const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

export const sessionKey = (): string[] => ['session'];
const claudeProjectsKey = (): string[] => ['claude', 'projects'];
const claudeSessionsKey = (project: string): string[] => ['claude', 'sessions', project];
const claudeSettingsKey = (): string[] => ['claude', 'settings', daemonBase()];
const skillsKey = (): string[] => ['claude', 'skills', daemonBase()];
const skillKey = (id: string): string[] => ['claude', 'skill', daemonBase(), id];
const memoryKey = (project: string): string[] => ['claude', 'memory', project];
const memoryFileKey = (project: string, name: string): string[] => ['claude', 'memory', project, name];
const LIVE_LIST_MS = 5_000;
const LIVE_MEMORY_MS = 5_000;
export const stationsKey = (): string[] => ['stations', daemonBase()];
const connectorsKey = (): string[] => ['connectors', daemonBase()];
const connectorKey = (id: string): (string | number)[] => [
  'connector',
  id,
];

export function makeQueryClient(onAuthError: () => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err) => {
        if (err instanceof AuthError && !err.refused) onAuthError();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: (count, err) => !(err instanceof AuthError) && !(err instanceof StoppedError) && count < 2,
      },
    },
  });
}

export function queryError(err: unknown, fallback: string): string {
  if (err instanceof AuthError) return EXPIRED;
  return err instanceof Error ? err.message : fallback;
}

export function useUpdateQuery(): UseQueryResult<UpdateCheck> {
  return useQuery({
    queryKey: ['update', daemonBase()],
    queryFn: () => fetchUpdate(),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export const serversKey = (): string[] => ['servers'];
const STATUS_POLL_MS = 15_000;

export function useServersQuery(): UseQueryResult<Server[]> {
  return useQuery({ queryKey: serversKey(), queryFn: () => fetchServers(), staleTime: 30_000 });
}

export function useServerStatus(host: string): UseQueryResult<ServerStatus> {
  return useQuery({
    queryKey: ['server-status', host],
    queryFn: () => probeServer(host),
    refetchInterval: STATUS_POLL_MS,
    staleTime: 5_000,
    retry: false,
  });
}

export function refreshServers(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: serversKey() });
}

export function refreshServerStatus(client: QueryClient, host: string): Promise<void> {
  return client.invalidateQueries({ queryKey: ['server-status', host] });
}

export function useMachineQuery(): UseQueryResult<Machine> {
  return useQuery({
    queryKey: ['machine', daemonBase()],
    queryFn: () => fetchMachine(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useClaudeSessionQuery(): UseQueryResult<ClaudeSessionStatus> {
  return useQuery({
    queryKey: ['claude-session', daemonBase()],
    queryFn: () => fetchClaudeSession(),
    staleTime: 3_000,
    refetchInterval: 10_000,
  });
}

export function useClaudeSetupQuery(): UseQueryResult<ClaudeSetup> {
  return useQuery({
    queryKey: ['claude-setup', daemonBase()],
    queryFn: () => fetchClaudeSetup(),
    staleTime: 10_000,
  });
}

export function refreshClaudeSetup(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ['claude-setup', daemonBase()] });
}

export function refreshClaudeSession(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ['claude-session', daemonBase()] });
}

export function useModelQuery(): UseQueryResult<ModelSettings> {
  return useQuery({
    queryKey: ['model', daemonBase()],
    queryFn: () => fetchModel(),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

export function refreshModel(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ['model', daemonBase()] });
}

export function useOpenRouterModelsQuery(enabled: boolean): UseQueryResult<ModelOption[]> {
  return useQuery({
    queryKey: ['openrouter', 'models', daemonBase()],
    queryFn: () => openrouterModels(),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useCodexModelsQuery(enabled: boolean): UseQueryResult<ModelOption[]> {
  return useQuery({
    queryKey: ['codex', 'models', daemonBase()],
    queryFn: async () => (await codexModels()).map((id) => ({ id, name: id })),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useModeQuery(): UseQueryResult<ModeInfo> {
  return useQuery({
    queryKey: ['mode', daemonBase()],
    queryFn: () => fetchMode(),
    staleTime: 60_000,
  });
}

export function useSessionQuery(): UseQueryResult<string> {
  return useQuery({
    queryKey: sessionKey(),
    queryFn: () => fetchSession(),
    staleTime: 5 * 60_000,
  });
}

export function useStationsQuery(): UseQueryResult<StationsView> {
  const client = useQueryClient();
  return useQuery({
    queryKey: stationsKey(),
    refetchInterval: (query) =>
      (query.state.data?.unavailable.length ?? 0) > 0 ? STARTING_POLL_MS : false,
    queryFn: async () => {
      const next = await fetchStations();
      const prev = client.getQueryData<StationsView>(stationsKey());
      return {
        ...next,
        groups: carryForward(next.groups, prev?.groups ?? [], next.unavailable),
      };
    },
  });
}

export function useClaudeProjectsQuery(): UseQueryResult<ClaudeProject[]> {
  return useQuery({
    queryKey: claudeProjectsKey(),
    queryFn: () => fetchClaudeProjects(),
    refetchInterval: LIVE_LIST_MS,
  });
}

export function useClaudeSessionsQuery(project: string): UseQueryResult<ClaudeSession[]> {
  return useQuery({
    queryKey: claudeSessionsKey(project),
    queryFn: () => fetchClaudeSessions(project),
    refetchInterval: LIVE_LIST_MS,
  });
}

export function removeClaudeSession(client: QueryClient, project: string, id: string): Promise<void> {
  return deleteClaudeSession(project, id).then(() => {
    invalidate(client, [claudeSessionsKey(project), claudeProjectsKey()]);
  });
}

export function useClaudeSettingsQuery(): UseQueryResult<ClaudeSettingsFile[]> {
  return useQuery({
    queryKey: claudeSettingsKey(),
    queryFn: () => fetchClaudeSettings(),
    staleTime: 30_000,
  });
}

export function refreshClaudeSettings(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: claudeSettingsKey() });
}

export function useClaudeSkillsQuery(enabled = true): UseQueryResult<SkillListing> {
  return useQuery({
    queryKey: skillsKey(),
    queryFn: () => fetchClaudeSkills(),
    refetchInterval: LIVE_LIST_MS,
    enabled,
  });
}

export function useClaudeSkillQuery(id: string): UseQueryResult<ClaudeSkill & { text: string }> {
  return useQuery({
    queryKey: skillKey(id),
    queryFn: () => fetchClaudeSkill(id),
  });
}

export async function refreshClaudeSkills(client: QueryClient, id?: string): Promise<void> {
  await client.invalidateQueries({ queryKey: skillsKey() });
  if (id !== undefined) await client.invalidateQueries({ queryKey: skillKey(id) });
}

export function useMemoryQuery(project: string): UseQueryResult<MemoryListing> {
  return useQuery({
    queryKey: memoryKey(project),
    queryFn: () => fetchMemory(project),
    refetchInterval: LIVE_MEMORY_MS,
  });
}

export function useMemoryFileQuery(project: string, name: string): UseQueryResult<string> {
  return useQuery({
    queryKey: memoryFileKey(project, name),
    queryFn: () => fetchMemoryFile(project, name),
    refetchInterval: LIVE_MEMORY_MS,
  });
}

function invalidate(client: QueryClient, keys: (string | number)[][]): void {
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function refreshAgents(client: QueryClient): void {
  invalidate(client, [stationsKey()]);
}

export function useConnectorsQuery(): UseQueryResult<ConnectorsView> {
  return useQuery({
    queryKey: connectorsKey(),
    queryFn: () => fetchConnectors(),
  });
}

export function refreshConnectors(client: QueryClient, id?: string): void {
  const keys: (string | number)[][] = [connectorsKey(), stationsKey()];
  if (id !== undefined) keys.push(connectorKey(id));
  invalidate(client, keys);
}

export function useConnectorQuery(
  id: string,
): UseQueryResult<Connector> {
  return useQuery({
    queryKey: connectorKey(id),
    queryFn: () => fetchConnector(id),
  });
}

function withoutAccount(
  groups: AccountGroup[],
  station: string,
  accountId: string,
): AccountGroup[] {
  return groups
    .map((g) =>
      g.station === station
        ? { station: g.station, rows: g.rows.filter((r) => r.id !== accountId) }
        : g,
    )
    .filter((g) => g.rows.length > 0);
}

export function dropAccount(client: QueryClient, station: string, accountId: string): void {
  client.setQueryData<StationsView>(stationsKey(), (prev) =>
    prev === undefined
      ? prev
      : { ...prev, groups: withoutAccount(prev.groups, station, accountId) },
  );
}
