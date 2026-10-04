import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchAws, fetchInstances, fetchServerLink, type AwsOverview, type FoundInstances, type ServerLink } from '@metro-labs/client/api/aws';
import { orgKey } from './queries.js';

export const useAwsQuery = (): UseQueryResult<AwsOverview> => useQuery({ queryKey: orgKey('aws'), queryFn: fetchAws, staleTime: 30_000, retry: false });

export const useServerLinkQuery = (serverId: string): UseQueryResult<ServerLink> =>
  useQuery({ queryKey: orgKey('aws-link', serverId), queryFn: () => fetchServerLink(serverId), staleTime: 30_000, retry: false });

export const useInstancesQuery = (enabled: boolean): UseQueryResult<FoundInstances> =>
  useQuery({ queryKey: orgKey('aws-instances'), queryFn: fetchInstances, staleTime: 30_000, retry: false, enabled });

export const refreshAws = (client: QueryClient): Promise<void> => client.invalidateQueries({ queryKey: orgKey() });
