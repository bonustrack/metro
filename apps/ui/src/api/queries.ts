import {
  QueryCache,
  QueryClient,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { daemonBase } from '../auth/daemon.js';
import { carryForward, type AccountGroup } from './accounts.js';
import { AuthError, StoppedError, fetchSession, fetchStations, type StationsView } from './client.js';
import { fetchApprovals, type Approval } from './approvals.js';
import { fetchConnector, fetchConnectors, type Connector, type ConnectorsView } from './connectors.js';
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
import { fetchClaudeSession, fetchClaudeSetup, fetchClaudeVersion, type ClaudeSessionStatus, type ClaudeSetup, type ClaudeVersion } from './claude-box.js';
import { fetchMode, type ModeInfo } from './mode.js';
import { fetchUpdate, type UpdateCheck } from './update.js';
import { fetchServers, probeServer, type Server, type ServerStatus } from './servers.js';
import { fetchMachine, type Machine } from './machine.js';
import { fetchLaunchOverview, type LaunchOverview } from './launch.js';
import { anthropicModels, bedrockModels, codexModels, fetchModel, geminiModels, openrouterModels, openrouterZdrModels, type ModelOption, type ModelSettings } from './model.js';
import { fetchSchedules, type Schedules } from './schedules.js';
import { currentOrganization } from '../auth/org-route.js';

const STALE_MS = 60_000;
const STARTING_POLL_MS = 3_000;
const LIVE_MS = 5_000;
const LONG_MS = 10 * 60_000;
const STATUS_POLL_MS = 15_000;
const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

type BoxName =
  | 'update'
  | 'approvals'
  | 'machine'
  | 'claude-session'
  | 'claude-setup'
  | 'claude-version'
  | 'claude-projects'
  | 'claude-sessions'
  | 'claude-settings'
  | 'claude-skills'
  | 'claude-skill'
  | 'memory'
  | 'model'
  | 'openrouter-zdr'
  | 'connection-models'
  | 'mode'
  | 'session'
  | 'stations'
  | 'connectors'
  | 'connector'
  | 'connector-tools'
  | 'account-name'
  | 'schedules'
  | 'schedule'
  | 'sender-cards'
  | 'agent-files'
  | 'vault';

export type BoxKey = BoxName | readonly [BoxName, ...string[]];

export function boxKey(key: BoxKey): string[] {
  const [name, ...parts] = typeof key === 'string' ? [key] : key;
  return [name, daemonBase(), ...parts];
}

type BoxOptions<T> = Omit<UseQueryOptions<T, Error, T, string[]>, 'queryKey' | 'queryFn'>;

export function useBoxQuery<T>(key: BoxKey, fn: () => Promise<T>, options: BoxOptions<T> = {}): UseQueryResult<T> {
  return useQuery({ ...options, queryKey: boxKey(key), queryFn: () => fn() });
}

export function refresh(client: QueryClient, key: BoxKey): Promise<void> {
  return client.invalidateQueries({ queryKey: boxKey(key) });
}

function refreshQuietly(client: QueryClient, keys: BoxKey[]): void {
  for (const key of keys) refresh(client, key).catch(() => undefined);
}

export const stationsKey = (): string[] => boxKey('stations');

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

export const orgKey = (...parts: string[]): string[] => ['org', currentOrganization() ?? 'none', ...parts];

export const serversKey = (): string[] => orgKey('servers');

export function useServersQuery(): UseQueryResult<Server[]> {
  return useQuery({ queryKey: serversKey(), queryFn: () => fetchServers(), staleTime: 30_000 });
}

export function useLaunchOverviewQuery(): UseQueryResult<LaunchOverview> {
  return useQuery({ queryKey: orgKey('launch-overview'), queryFn: () => fetchLaunchOverview(), staleTime: 60_000, retry: false });
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

export const useUpdateQuery = (): UseQueryResult<UpdateCheck> => useBoxQuery('update', fetchUpdate, { staleTime: LONG_MS, retry: false });

export const useMachineQuery = (): UseQueryResult<Machine> =>
  useBoxQuery('machine', fetchMachine, { staleTime: 30_000, refetchInterval: 60_000 });

export const useClaudeSessionQuery = (): UseQueryResult<ClaudeSessionStatus> =>
  useBoxQuery('claude-session', fetchClaudeSession, { staleTime: 3_000, refetchInterval: 10_000 });

export const useClaudeSetupQuery = (): UseQueryResult<ClaudeSetup> => useBoxQuery('claude-setup', fetchClaudeSetup, { staleTime: 10_000 });

export const useSchedulesQuery = (enabled: boolean): UseQueryResult<Schedules> =>
  useBoxQuery('schedules', fetchSchedules, { staleTime: 15_000, enabled, retry: false });


export const useClaudeVersionQuery = (): UseQueryResult<ClaudeVersion> =>
  useBoxQuery('claude-version', fetchClaudeVersion, { staleTime: LONG_MS, retry: false });

export const useModelQuery = (): UseQueryResult<ModelSettings> =>
  useBoxQuery('model', fetchModel, { staleTime: 5_000, refetchInterval: STATUS_POLL_MS });

export const useOpenRouterZdrQuery = (enabled: boolean): UseQueryResult<Set<string>> =>
  useBoxQuery('openrouter-zdr', openrouterZdrModels, { enabled, staleTime: LONG_MS });

async function connectionModels(provider: string, id: string): Promise<ModelOption[]> {
  if (provider === 'anthropic') return anthropicModels(id);
  if (provider === 'bedrock') return bedrockModels(id);
  if (provider === 'openrouter') return openrouterModels();
  const ids = provider === 'gemini' ? await geminiModels(id) : await codexModels(id);
  return ids.map((each) => ({ id: each, name: each }));
}

export function useConnectionModelsQuery(connection: { id: string; provider: string } | undefined): UseQueryResult<ModelOption[]> {
  const id = connection?.id ?? '';
  const provider = connection?.provider ?? '';
  return useBoxQuery(['connection-models', provider, id], () => connectionModels(provider, id), { enabled: id !== '', staleTime: LONG_MS });
}

export const useApprovalsQuery = (enabled: boolean): UseQueryResult<Approval[]> =>
  useBoxQuery('approvals', fetchApprovals, { enabled, staleTime: 5_000, refetchInterval: enabled ? 15_000 : false });

export const useModeQuery = (): UseQueryResult<ModeInfo> => useBoxQuery('mode', fetchMode, { staleTime: 60_000 });

export const useSessionQuery = (): UseQueryResult<string> => useBoxQuery('session', fetchSession, { staleTime: 5 * 60_000 });

export function useStationsQuery(): UseQueryResult<StationsView> {
  const client = useQueryClient();
  return useBoxQuery(
    'stations',
    async () => {
      const next = await fetchStations();
      const prev = client.getQueryData<StationsView>(stationsKey());
      return { ...next, groups: carryForward(next.groups, prev?.groups ?? [], next.unavailable) };
    },
    { refetchInterval: (query) => ((query.state.data?.unavailable.length ?? 0) > 0 ? STARTING_POLL_MS : false) },
  );
}

export const useClaudeProjectsQuery = (): UseQueryResult<ClaudeProject[]> =>
  useBoxQuery('claude-projects', fetchClaudeProjects, { refetchInterval: LIVE_MS });

export const useClaudeSessionsQuery = (project: string): UseQueryResult<ClaudeSession[]> =>
  useBoxQuery(['claude-sessions', project], () => fetchClaudeSessions(project), { refetchInterval: LIVE_MS });

export async function removeClaudeSession(client: QueryClient, project: string, id: string): Promise<void> {
  await deleteClaudeSession(project, id);
  refreshQuietly(client, [['claude-sessions', project], 'claude-projects']);
}

export const useClaudeSettingsQuery = (): UseQueryResult<ClaudeSettingsFile[]> =>
  useBoxQuery('claude-settings', fetchClaudeSettings, { staleTime: 30_000 });

export const useClaudeSkillsQuery = (): UseQueryResult<SkillListing> => useBoxQuery('claude-skills', fetchClaudeSkills, { refetchInterval: LIVE_MS });

export const useClaudeSkillQuery = (id: string): UseQueryResult<ClaudeSkill & { text: string }> =>
  useBoxQuery(['claude-skill', id], () => fetchClaudeSkill(id));

export async function refreshClaudeSkills(client: QueryClient, id?: string): Promise<void> {
  await refresh(client, 'claude-skills');
  if (id !== undefined) await refresh(client, ['claude-skill', id]);
}

export const useMemoryQuery = (project: string): UseQueryResult<MemoryListing> =>
  useBoxQuery(['memory', project], () => fetchMemory(project), { refetchInterval: LIVE_MS });

export const useMemoryFileQuery = (project: string, name: string): UseQueryResult<string> =>
  useBoxQuery(['memory', project, name], () => fetchMemoryFile(project, name), { refetchInterval: LIVE_MS });

export const useConnectorsQuery = (): UseQueryResult<ConnectorsView> => useBoxQuery('connectors', fetchConnectors);

export const useConnectorQuery = (id: string): UseQueryResult<Connector> => useBoxQuery(['connector', id], () => fetchConnector(id));

export function refreshAgents(client: QueryClient): void {
  refreshQuietly(client, ['stations']);
}

export function refreshConnectors(client: QueryClient, id?: string): void {
  refreshQuietly(client, id === undefined ? ['connectors', 'stations'] : ['connectors', 'stations', ['connector', id]]);
}

function withoutAccount(groups: AccountGroup[], station: string, accountId: string): AccountGroup[] {
  return groups
    .map((g) => (g.station === station ? { station: g.station, rows: g.rows.filter((r) => r.id !== accountId) } : g))
    .filter((g) => g.rows.length > 0);
}

export function dropAccount(client: QueryClient, station: string, accountId: string): void {
  client.setQueryData<StationsView>(stationsKey(), (prev) =>
    prev === undefined ? prev : { ...prev, groups: withoutAccount(prev.groups, station, accountId) },
  );
}
