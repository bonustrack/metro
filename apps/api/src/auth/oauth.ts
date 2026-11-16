import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { verifyIdToken } from './id-token.js';
import { SignInRefused, type OAuthProvider, type OAuthProviders, type Proof, type ProviderId } from './providers.js';

const FETCH_MS = 15_000;

export interface Attempt {
  provider: ProviderId;
  nonce: string;
  verifier: string;
}

const secret = (): string => randomBytes(32).toString('base64url');

export const newAttempt = (provider: ProviderId): Attempt => ({ provider, nonce: secret(), verifier: secret() });

export function providerOf(providers: OAuthProviders | undefined, id: ProviderId): OAuthProvider {
  const provider = providers?.[id];
  if (provider === undefined) throw new ApiError(`sign-in with ${id === 'google' ? 'Google' : 'Microsoft'} is not set up on this server`, 503);
  return provider;
}

export function authorizeUrl(provider: OAuthProvider, redirectUri: string, state: string, attempt: Attempt): string {
  const url = new URL(provider.endpoints.authorize);
  const params: Record<string, string> = {
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state,
    nonce: attempt.nonce,
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...provider.extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function idTokenFor(provider: OAuthProvider, code: string, redirectUri: string, verifier: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(provider.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: provider.clientId, client_secret: provider.clientSecret, redirect_uri: redirectUri, code_verifier: verifier }),
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch {
    throw new SignInRefused('failed', `${provider.id} did not answer the code exchange`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const said = isRecord(body) && typeof body.error === 'string' ? body.error : String(res.status);
    throw new SignInRefused('failed', `${provider.id} refused the code exchange (${said})`);
  }
  const token = isRecord(body) ? body.id_token : undefined;
  if (typeof token !== 'string' || token === '') throw new SignInRefused('failed', `${provider.id} answered the code exchange without an id_token`);
  return token;
}

export async function providerProof(provider: OAuthProvider, code: string, redirectUri: string, attempt: Attempt, now: number): Promise<Proof> {
  if (code === '') throw new SignInRefused('failed', 'the provider sent no code');
  const token = await idTokenFor(provider, code, redirectUri, attempt.verifier);
  return provider.proof(await verifyIdToken(provider, token, attempt.nonce, now));
}
