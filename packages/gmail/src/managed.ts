import { SignInError, type FetchLike, type Tokens } from '@metro-labs/core/stations/oauth';

const BASE = 'https://api.metro.box/api/gmail';
const reach: FetchLike = (input, init) => fetch(input, init);

export interface ManagedTokens extends Tokens {
  refreshGrant: string;
}

export async function managedRequest(path: 'start' | 'exchange' | 'cancel' | 'refresh' | 'revoke', body: Record<string, unknown>, bearer?: string, fetchImpl = reach): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: bearer }) },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new SignInError('Metro could not reach managed Gmail sign-in. Try again.');
  }
  if (!response.ok) {
    const retry = response.status >= 500 ? 'Try again later.' : 'Start Gmail sign-in again. Your Google Workspace administrator may need to allow the app.';
    throw new SignInError(`Metro could not complete managed Gmail sign-in. ${retry}`);
  }
  const value: unknown = await response.json().catch(() => null);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SignInError('Metro returned an invalid Gmail answer.');
  return value as Record<string, unknown>;
}

export function managedTokens(value: Record<string, unknown>): ManagedTokens {
  if (typeof value.accessToken !== 'string' || !value.accessToken || typeof value.refreshToken !== 'string' || !value.refreshToken || typeof value.refreshGrant !== 'string' || !value.refreshGrant || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt))
    throw new SignInError('Metro returned an incomplete Gmail sign-in.');
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, refreshGrant: value.refreshGrant, expiresAt: value.expiresAt };
}

export async function renewManaged(refreshToken: string, refreshGrant: string, host: string, fetchImpl = reach): Promise<ManagedTokens> {
  return managedTokens(await managedRequest('refresh', { refreshToken, refreshGrant, host }, undefined, fetchImpl));
}

export async function revokeManaged(refreshToken: string, refreshGrant: string, host: string, fetchImpl = reach): Promise<void> {
  const result = await managedRequest('revoke', { refreshToken, refreshGrant, host }, undefined, fetchImpl);
  if (result.revoked !== true) throw new SignInError('Metro did not confirm Google revocation. Try again.');
}
