import type { QueryClient } from '@tanstack/react-query';
import { fetchServers } from '@metro-labs/client/api/servers';

export function prefetchOrganization(client: QueryClient): (organization: string) => Promise<void> {
  return (organization) => client.prefetchQuery({ queryKey: ['org', organization, 'servers'], queryFn: () => fetchServers(), staleTime: 30_000 });
}
