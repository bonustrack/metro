import { useQuery } from '@tanstack/react-query';
import { activeAccount } from '@metro-labs/client/auth/account';
import { fetchOperator } from '@metro-labs/client/api/admin';

export function useOperator(): boolean | null {
  const account = activeAccount();
  const { data, isError } = useQuery({
    queryKey: ['operator', account?.user.id ?? null],
    queryFn: () => (account === null ? Promise.resolve(false) : fetchOperator()),
    staleTime: 5 * 60_000,
    retry: 2,
  });
  if (account === null || isError) return false;
  return data ?? null;
}
