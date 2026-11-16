import { useQuery } from '@tanstack/react-query';
import { fetchSignInOptions, WORKOS_SIGN_IN, type SignInOptions } from '@metro-labs/client/api/sign-in-options';
import type { Provider } from '@metro-labs/client/api/auth';

export const SIGN_IN_OPTIONS = 'sign-in-options';

const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub' };

export function useSignInOptions(): SignInOptions | null {
  const { data, isError } = useQuery({ queryKey: [SIGN_IN_OPTIONS], queryFn: fetchSignInOptions, staleTime: 10 * 60_000, retry: 2 });
  if (data !== undefined) return data;
  return isError ? WORKOS_SIGN_IN : null;
}

export const providerWords = (providers: Provider[]): string =>
  (providers.length === 0 ? (['google', 'microsoft'] as const) : providers).map((provider) => PROVIDER_NAME[provider]).join(' or ');
