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

const STALE_MS = 60_000;
const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

export const sessionKey = (): string[] => ['session'];
export const agentsKey = (): string[] => ['agents'];
export const stationsKey = (): string[] => ['stations'];
export const connectorsKey = (): string[] => ['connectors'];
export const connectorKey = (id: string): (string | number)[] => [
  'connector',
  id,
];
export const collectionsKey = (): string[] => ['lists'];
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

export function useStationsQuery(token: string): UseQueryResult<StationsView> {
  const client = useQueryClient();
  return useQuery({
    queryKey: stationsKey(),
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

export function useConnectorsQuery(token: string): UseQueryResult<ConnectorsView> {
  return useQuery({
    queryKey: connectorsKey(),
    queryFn: () => fetchConnectors(token),
  });
}

export function refreshConnectors(client: QueryClient, id?: string): void {
  const keys: (string | number)[][] = [connectorsKey(), collectionsKey()];
  if (id !== undefined) keys.push(connectorKey(id));
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function refreshCollections(client: QueryClient, id?: string): void {
  const keys: (string | number)[][] = [collectionsKey()];
  if (id !== undefined) keys.push(collectionKey(id));
  for (const queryKey of keys)
    client.invalidateQueries({ queryKey }).catch(() => undefined);
}

export function useCollectionsQuery(token: string): UseQueryResult<Collection[]> {
  return useQuery({ queryKey: collectionsKey(), queryFn: () => fetchCollections(token) });
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
): void {
  client.setQueryData<StationsView>(stationsKey(), (prev) =>
    prev === undefined
      ? prev
      : { ...prev, groups: withoutAccount(prev.groups, station, accountId) },
  );
}
