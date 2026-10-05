import { fetchOrganizations, type OrganizationRow } from '@metro-labs/client/api/auth';
import { activeAccount } from '@metro-labs/client/auth/account';
import {
  QueryCache,
  QueryClient,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { carryForward, type AccountGroup } from '@metro-labs/client/api/accounts';
import { AuthError, StoppedError, fetchSession, fetchStations, type StationsView } from '@metro-labs/client/api/client';
import { fetchApprovals, type Approval } from '@metro-labs/client/api/approvals';
import { fetchConnector, fetchConnectors, type Connector, type ConnectorsView } from '@metro-labs/client/api/connectors';
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
} from '@metro-labs/client/api/claude';
import { fetchClaudeAccount } from '@metro-labs/client/api/claude';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { fetchClaudeSession, fetchClaudeSetup, fetchClaudeVersion, type ClaudeSessionStatus, type ClaudeSetup, type ClaudeVersion } from '@metro-labs/client/api/claude-box';
import { fetchMode, type ModeInfo } from '@metro-labs/client/api/mode';
import { sessionPollMs } from '@metro-labs/client/api/runner-activity';
import { fetchUpdate, type UpdateCheck } from '@metro-labs/client/api/update';
import { fetchServers, probeServer, type Server, type ServerStatus } from '@metro-labs/client/api/servers';
import { fetchMachine, type Machine } from '@metro-labs/client/api/machine';
import { fetchUsage, type ResourceRange, type Usage } from '@metro-labs/client/api/resources';
import { fetchLatestUsage, type LatestUsage } from '@metro-labs/client/api/latest-usage';
import { fetchLaunchOverview, type LaunchOverview } from '@metro-labs/client/api/launch';
import { fetchSize, jobRunning, type SizeView } from '@metro-labs/client/api/size';
import { applying, fetchStorage, growRunning, type StorageView } from '@metro-labs/client/api/storage';
import { anthropicModels, bedrockModels, codexModels, fetchModel, geminiModels, openrouterModels, openrouterZdrModels, type ModelOption, type ModelSettings } from '@metro-labs/client/api/model';
import { fetchSchedules, type Schedules } from '@metro-labs/client/api/schedules';
import { currentOrganization } from '@metro-labs/client/auth/org-route';
import { readItem, writeItem } from '@metro-labs/client/platform';

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
  | 'claude-account'
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
  | 'vault'
  | 'voice';

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

const stationsKey = (): string[] => boxKey('stations');

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

const serversKey = (): string[] => orgKey('servers');

const SERVERS_CACHE = 'metro.servers:';

const isServerRow = (v: unknown): v is Server =>
  typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { host?: unknown }).host === 'string';

function cachedServers(key: string): Server[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readItem(`${SERVERS_CACHE}${key}`) ?? 'null');
    return Array.isArray(parsed) && parsed.every(isServerRow) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function keepServers(key: string, servers: Server[]): Server[] {
  writeItem(`${SERVERS_CACHE}${key}`, JSON.stringify(servers));
  return servers;
}

export function useServersQuery(): UseQueryResult<Server[]> {
  const key = serversKey();
  const org = key[1] ?? 'none';
  return useQuery({
    queryKey: key,
    queryFn: async () => keepServers(org, await fetchServers()),
    staleTime: 30_000,
    initialData: () => cachedServers(org),
    initialDataUpdatedAt: 0,
    refetchOnMount: true,
  });
}

const ORGANIZATIONS_CACHE = 'metro.organizations:';

const isOrganizationRow = (v: unknown): v is OrganizationRow => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';

function cachedOrganizations(user: string): OrganizationRow[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readItem(`${ORGANIZATIONS_CACHE}${user}`) ?? 'null');
    return Array.isArray(parsed) && parsed.every(isOrganizationRow) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function keepOrganizations(user: string, rows: OrganizationRow[]): OrganizationRow[] {
  writeItem(`${ORGANIZATIONS_CACHE}${user}`, JSON.stringify(rows));
  return rows;
}

export function useOrganizationsQuery(): UseQueryResult<OrganizationRow[]> {
  const user = activeAccount()?.user.id ?? 'none';
  return useQuery({
    queryKey: ['organizations', user],
    queryFn: async () => keepOrganizations(user, await fetchOrganizations()),
    staleTime: 30_000,
    initialData: () => cachedOrganizations(user),
    initialDataUpdatedAt: 0,
    refetchOnMount: true,
  });
}

export function useLaunchOverviewQuery(): UseQueryResult<LaunchOverview> {
  return useQuery({ queryKey: orgKey('launch-overview'), queryFn: () => fetchLaunchOverview(), staleTime: 60_000, retry: false });
}

const RESIZE_POLL_MS = 3_000;
const MOVING = ['pending', 'stopping', 'shutting-down'];

const resizePoll = (data: SizeView | null | undefined): number | false =>
  data?.resizable === true && (jobRunning(data.job) || MOVING.includes(data.state)) ? RESIZE_POLL_MS : false;

export function useSizeQuery(serverId: string): UseQueryResult<SizeView | null> {
  return useQuery({
    queryKey: orgKey('size', serverId),
    queryFn: () => fetchSize(serverId),
    staleTime: 30_000,
    refetchOnMount: true,
    retry: false,
    refetchInterval: (query) => resizePoll(query.state.data),
  });
}

const CHANGE_POLL_MS = 15_000;

const storagePoll = (data: StorageView | null | undefined): number | false => {
  if (data?.growable !== true) return false;
  if (growRunning(data.job)) return RESIZE_POLL_MS;
  return applying(data.modification) ? CHANGE_POLL_MS : false;
};

export const useStorageQuery = (serverId: string): UseQueryResult<StorageView | null> =>
  useQuery({ queryKey: orgKey('storage', serverId), queryFn: () => fetchStorage(serverId), staleTime: 30_000, retry: false, refetchInterval: (query) => storagePoll(query.state.data) });

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

export const useUsageQuery = (serverId: string, range: ResourceRange): UseQueryResult<Usage | null> =>
  useQuery({ queryKey: orgKey('usage', serverId, range), queryFn: () => fetchUsage(serverId, range), staleTime: 30_000, refetchInterval: 60_000, retry: false });

export const useLatestUsageQuery = (): UseQueryResult<Record<string, LatestUsage>> =>
  useQuery({ queryKey: orgKey('latest-usage'), queryFn: fetchLatestUsage, staleTime: 60_000, refetchInterval: 60_000, retry: false });

export const useClaudeSessionQuery = ({ live = false }: { live?: boolean } = {}): UseQueryResult<ClaudeSessionStatus> =>
  useBoxQuery('claude-session', fetchClaudeSession, { staleTime: 3_000, refetchInterval: (query) => sessionPollMs(query.state.data, live) });

function useClaudeLoginOf(conn: ConnectionRow | undefined): string | null {
  const own = conn === undefined || (conn.provider === 'anthropic' && !conn.hasKey && !conn.signedIn);
  const account = useBoxQuery('claude-account', fetchClaudeAccount, { staleTime: 60_000, enabled: own });
  return own ? (account.data?.account ?? null) : null;
}

export function useAccountOf(conn: ConnectionRow | undefined): string | null {
  const login = useClaudeLoginOf(conn);
  return login ?? conn?.account ?? null;
}

export const useClaudeSetupQuery = (): UseQueryResult<ClaudeSetup> => useBoxQuery('claude-setup', fetchClaudeSetup, { staleTime: 10_000 });

export const useSchedulesQuery = (): UseQueryResult<Schedules> => useBoxQuery('schedules', fetchSchedules, { staleTime: 15_000, retry: false });

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

export const useApprovalsQuery = (): UseQueryResult<Approval[]> =>
  useBoxQuery('approvals', fetchApprovals, { staleTime: 5_000, refetchInterval: 15_000 });

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

export function resetDestinationConnectors(client: QueryClient, base: string): void {
  for (const key of ['connectors', 'stations']) {
    client.removeQueries({ queryKey: [key, base], type: 'inactive' });
    client.invalidateQueries({ queryKey: [key, base], refetchType: 'active' }).catch(() => undefined);
  }
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
