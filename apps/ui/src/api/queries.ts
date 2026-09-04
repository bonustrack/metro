import {
  QueryCache,
  QueryClient,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { carryForward, type AccountGroup } from './accounts';
import {
  AuthError,
  fetchAgents,
  fetchSession,
  fetchStations,
  type AgentsView,
  type StationsView,
} from './client';
import {
  fetchConnector,
  fetchConnectors,
  type Connector,
  type ConnectorsView,
} from './connectors';
import {
  fetchClaudeProjects,
  fetchClaudeSessions,
  fetchMemory,
  fetchMemoryFile,
  deleteClaudeSession,
  type ClaudeProject,
  type ClaudeSession,
  type MemoryListing,
} from './claude';
import { daemonBase } from '../auth/session';

const STALE_MS = 60_000;
const STARTING_POLL_MS = 3_000;
const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

export const sessionKey = (): string[] => ['session'];
const claudeProjectsKey = (): string[] => ['claude', 'projects'];
const claudeSessionsKey = (project: string): string[] => ['claude', 'sessions', project];
const memoryKey = (project: string): string[] => ['claude', 'memory', project];
const memoryFileKey = (project: string, name: string): string[] => ['claude', 'memory', project, name];
const LIVE_LIST_MS = 5_000;
const LIVE_MEMORY_MS = 5_000;
const agentsKey = (): string[] => ['agents', daemonBase()];
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
        if (err instanceof AuthError) onAuthError();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: (count, err) => !(err instanceof AuthError) && count < 2,
      },
    },
  });
}

export function queryError(err: unknown, fallback: string): string {
  if (err instanceof AuthError) return EXPIRED;
  return err instanceof Error ? err.message : fallback;
}

export function useSessionQuery(token: string): UseQueryResult<string> {
  return useQuery({
    queryKey: sessionKey(),
    queryFn: () => fetchSession(token),
    staleTime: 5 * 60_000,
  });
}

export function useAgentsQuery(token: string): UseQueryResult<AgentsView> {
  return useQuery({
    queryKey: agentsKey(),
    queryFn: () => fetchAgents(token),
  });
}

export function useStationsQuery(token: string): UseQueryResult<StationsView> {
  const client = useQueryClient();
  return useQuery({
    queryKey: stationsKey(),
    refetchInterval: (query) =>
      (query.state.data?.unavailable.length ?? 0) > 0 ? STARTING_POLL_MS : false,
    queryFn: async () => {
      const next = await fetchStations(token);
      const prev = client.getQueryData<StationsView>(stationsKey());
      return {
        ...next,
        groups: carryForward(next.groups, prev?.groups ?? [], next.unavailable),
      };
    },
  });
}

export function useClaudeProjectsQuery(token: string): UseQueryResult<ClaudeProject[]> {
  return useQuery({
    queryKey: claudeProjectsKey(),
    queryFn: () => fetchClaudeProjects(token),
    refetchInterval: LIVE_LIST_MS,
  });
}

export function useClaudeSessionsQuery(token: string, project: string): UseQueryResult<ClaudeSession[]> {
  return useQuery({
    queryKey: claudeSessionsKey(project),
    queryFn: () => fetchClaudeSessions(token, project),
    refetchInterval: LIVE_LIST_MS,
  });
}

export function removeClaudeSession(client: QueryClient, token: string, project: string, id: string): Promise<void> {
  return deleteClaudeSession(token, project, id).then(() => {
    invalidate(client, [claudeSessionsKey(project), claudeProjectsKey()]);
  });
}

export function useMemoryQuery(token: string, project: string): UseQueryResult<MemoryListing> {
  return useQuery({
    queryKey: memoryKey(project),
    queryFn: () => fetchMemory(token, project),
    refetchInterval: LIVE_MEMORY_MS,
  });
}

export function useMemoryFileQuery(token: string, project: string, name: string): UseQueryResult<string> {
  return useQuery({
    queryKey: memoryFileKey(project, name),
    queryFn: () => fetchMemoryFile(token, project, name),
    refetchInterval: LIVE_MEMORY_MS,
  });
}

function invalidate(client: QueryClient, keys: (string | number)[][]): void {
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function refreshAgents(client: QueryClient): void {
  invalidate(client, [agentsKey(), stationsKey()]);
}

export function useConnectorsQuery(token: string): UseQueryResult<ConnectorsView> {
  return useQuery({
    queryKey: connectorsKey(),
    queryFn: () => fetchConnectors(token),
  });
}

export function refreshConnectors(client: QueryClient, id?: string): void {
  const keys: (string | number)[][] = [connectorsKey(), agentsKey(), stationsKey()];
  if (id !== undefined) keys.push(connectorKey(id));
  invalidate(client, keys);
}

export function useConnectorQuery(
  token: string,
  id: string,
): UseQueryResult<Connector> {
  return useQuery({
    queryKey: connectorKey(id),
    queryFn: () => fetchConnector(token, id),
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
