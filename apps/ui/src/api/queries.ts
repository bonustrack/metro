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
  type ConnectorList,
} from './connectors';

const STALE_MS = 60_000;
const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

export const sessionKey = (): string[] => ['session'];
export const agentsKey = (): string[] => ['agents'];
export const stationsKey = (): string[] => ['stations'];
export const connectorsKey = (): string[] => ['connectors'];
export const connectorKey = (id: number): (string | number)[] => [
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

export function useConnectorsQuery(token: string): UseQueryResult<ConnectorList> {
  return useQuery({
    queryKey: connectorsKey(),
    queryFn: () => fetchConnectors(token),
  });
}

export function useConnectorQuery(
  token: string,
  id: number,
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
