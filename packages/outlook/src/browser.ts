import { SignInError, tokensOf, type FetchLike, type Tokens } from '@metro-labs/core/stations/oauth';
import { failureOf, postLogin, requireClientId, tenantOf } from './auth.js';
import { loginBase, redirectUri, SCOPES } from './config.js';

export function authorizeUrl(challenge: string, state: string, loginHint: string | null = null): string {
  const query = new URLSearchParams({
    ...(loginHint === null ? {} : { login_hint: loginHint }),
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
  const { status, body } = await postLogin(
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
  if (status !== 200) throw new SignInError(failureOf(body));
  const tokens = tokensOf(body, now, 'Microsoft');
  return { tokens, tenantId: tenantOf(typeof body.id_token === 'string' ? body.id_token : '', tokens.accessToken) };
}
