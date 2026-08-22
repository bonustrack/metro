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
  fetchSession,
  fetchStations,
  type StationsView,
} from './client';
import {
  fetchConnector,
  fetchConnectors,
  type Connector,
  type ConnectorsView,
} from './connectors';
import { fetchCollection, fetchCollections, type Collection } from './collections';
import {
  fetchMembers,
  fetchProjects,
  type Member,
  type Project,
} from './projects';

const STALE_MS = 60_000;
const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

export const sessionKey = (): string[] => ['session'];
export const projectsKey = (): string[] => ['projects'];
export const membersKey = (project: string): string[] => ['members', project];
export const agentsKey = (project: string): string[] => ['agents', project];
export const stationsKey = (project: string): string[] => ['stations', project];
export const connectorsKey = (project: string): string[] => [
  'connectors',
  project,
];
export const connectorKey = (id: string): (string | number)[] => [
  'connector',
  id,
];
export const collectionsKey = (project: string): string[] => [
  'collections',
  project,
];
export const collectionKey = (id: string): (string | number)[] => ['list', id];

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

export function useStationsQuery(
  token: string,
  project: string,
): UseQueryResult<StationsView> {
  const client = useQueryClient();
  return useQuery({
    queryKey: stationsKey(project),
    queryFn: async () => {
      const next = await fetchStations(token, project);
      const prev = client.getQueryData<StationsView>(stationsKey(project));
      return {
        ...next,
        groups: carryForward(next.groups, prev?.groups ?? [], next.unavailable),
      };
    },
  });
}

export function useProjectsQuery(token: string): UseQueryResult<Project[]> {
  return useQuery({
    queryKey: projectsKey(),
    queryFn: () => fetchProjects(token),
    staleTime: 5 * 60_000,
  });
}

export function useMembersQuery(
  token: string,
  project: string,
): UseQueryResult<Member[]> {
  return useQuery({
    queryKey: membersKey(project),
    queryFn: () => fetchMembers(token, project),
  });
}

export function refreshProjects(client: QueryClient, project?: string): void {
  const keys: (string | number)[][] = [projectsKey()];
  if (project !== undefined) keys.push(membersKey(project));
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function useConnectorsQuery(
  token: string,
  project: string,
): UseQueryResult<ConnectorsView> {
  return useQuery({
    queryKey: connectorsKey(project),
    queryFn: () => fetchConnectors(token, project),
  });
}

export function refreshConnectors(
  client: QueryClient,
  project: string,
  id?: string,
): void {
  const keys: (string | number)[][] = [
    connectorsKey(project),
    collectionsKey(project),
  ];
  if (id !== undefined) keys.push(connectorKey(id));
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function refreshCollections(
  client: QueryClient,
  project: string,
  id?: string,
): void {
  const keys: (string | number)[][] = [collectionsKey(project)];
  if (id !== undefined) keys.push(collectionKey(id));
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function useCollectionsQuery(
  token: string,
  project: string,
): UseQueryResult<Collection[]> {
  return useQuery({
    queryKey: collectionsKey(project),
    queryFn: () => fetchCollections(token, project),
  });
}

export function useCollectionQuery(
  token: string,
  id: string,
): UseQueryResult<Collection> {
  return useQuery({ queryKey: collectionKey(id), queryFn: () => fetchCollection(token, id) });
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

export function dropAccount(
  client: QueryClient,
  station: string,
  accountId: string,
  project: string,
): void {
  client.setQueryData<StationsView>(stationsKey(project), (prev) =>
    prev === undefined
      ? prev
      : { ...prev, groups: withoutAccount(prev.groups, station, accountId) },
  );
}
