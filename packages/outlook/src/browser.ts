import { createHash, randomBytes } from 'node:crypto';
import { failureOf, OutlookAuthError, postForm, requireClientId, tenantOf, tokensOf, type FetchLike, type Tokens } from './auth.js';
import { loginBase, redirectUri, SCOPES } from './config.js';

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkcePair(verifier = randomBytes(32).toString('base64url')): Pkce {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const newState = (): string => randomBytes(24).toString('base64url');

export function authorizeUrl(challenge: string, state: string): string {
  const query = new URLSearchParams({
    client_id: requireClientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${loginBase()}/oauth2/v2.0/authorize?${query.toString()}`;
}

export interface Redeemed {
  tokens: Tokens;
  tenantId: string | null;
}

export async function redeemCode(code: string, verifier: string, fetchImpl: FetchLike, now = Date.now()): Promise<Redeemed> {
  const { status, body } = await postForm(
    'token',
    {
      grant_type: 'authorization_code',
      client_id: requireClientId(),
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
      scope: SCOPES,
    },
    fetchImpl,
  );
  if (status !== 200) throw new OutlookAuthError(failureOf(body));
  const tokens = tokensOf(body, now);
  return { tokens, tenantId: tenantOf(typeof body.id_token === 'string' ? body.id_token : '', tokens.accessToken) };
}
