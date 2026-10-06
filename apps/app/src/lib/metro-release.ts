import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchMetroRelease, type MetroRelease } from '@metro-labs/client/api/metro-release';

export const useMetroRelease = (): UseQueryResult<MetroRelease> => useQuery({
  queryKey: ['metro-release'], queryFn: ({ signal }) => fetchMetroRelease(signal),
  staleTime: 60_000, refetchInterval: 60_000, refetchOnMount: true,
  refetchOnWindowFocus: true, retry: false,
});
