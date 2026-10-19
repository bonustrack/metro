import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { whyUnreachable } from './connector-reach.js';
import { ConnectorVerifyError, refused } from './connector-url.js';
import type { OAuthTokens } from './connector-mcp.js';
import type { OAuthServer } from './connector-discovery.js';

const TOKEN_TIMEOUT_MS = 15_000;
const CLIENT_NAME = 'Metro';

export class OAuthInvalidGrant extends ConnectorVerifyError {}

const SIGN_IN_AGAIN = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function registerClient(
  server: OAuthServer,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthClient> {
  if (server.registrationEndpoint === null)
    throw refused(
      'That server signs in with OAuth but registers no clients on its own. ' +
        `Register an app with it yourself, with ${redirectUri} as its redirect URL, ` +
        "and add the connector again with that app's client ID.",
    );
  let res: Response;
  try {
    res = await fetchImpl(server.registrationEndpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch (err) {
    throw refused(`Metro could not reach that server to register: ${whyUnreachable(err)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body) || typeof body.client_id !== 'string')
    throw refused('That server refused to register Metro as a client.');
  const secret = body.client_secret;
  return {
    clientId: body.client_id,
    ...(typeof secret === 'string' ? { clientSecret: secret } : {}),
  };
}

export interface AuthorizeInput {
  server: OAuthServer;
  client: OAuthClient;
  redirectUri: string;
  state: string;
  verifier: string;
  resource: string;
}

export function authorizeUrl(input: AuthorizeInput): string {
  const url = new URL(input.server.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.client.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', challengeOf(input.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', input.resource);
  if (input.server.scopes.length > 0)
    url.searchParams.set('scope', input.server.scopes.join(' '));
  return url.toString();
}

function validateOptionalTokens(body: Record<string, unknown>): void {
  const refresh = body.refresh_token;
  if (Object.hasOwn(body, 'refresh_token') && (typeof refresh !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(refresh))) throw refused('That server returned an invalid refresh token.');
  if (Object.hasOwn(body, 'token_type') && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) throw refused('That server returned an unsupported token type.');
}

function expiryFrom(body: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(body, 'expires_in')) return undefined;
  const expires = body.expires_in;
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) throw refused('That server returned an invalid token expiry.');
  const at = Date.now() + expires * 1000;
  if (!Number.isSafeInteger(at)) throw refused('That server returned an invalid token expiry.');
  return at;
}

function tokensFrom(body: Record<string, unknown>): OAuthTokens {
  const access = body.access_token;
  if (typeof access !== 'string' || !/^[\x21-\x7e]{1,16377}$/.test(access))
    throw refused('That server did not return a sendable access token.');
  validateOptionalTokens(body);
  const expiresAt = expiryFrom(body);
  const refresh = body.refresh_token;
  return {
    accessToken: access,
    ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

async function postToken(
  server: OAuthServer,
  client: OAuthClient,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    ...form,
    client_id: client.clientId,
    ...(client.clientSecret === undefined
      ? {}
      : { client_secret: client.clientSecret }),
  });
  let res: Response;
  try {
    res = await fetchImpl(server.tokenEndpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    });
  } catch (err) {
    throw refused(`Metro could not reach that server to finish signing in: ${whyUnreachable(err)}`);
  }
  return tokenAnswer(form.grant_type === 'refresh_token', res.status, res.ok, await res.json().catch(() => null));
}

const errorCode = (body: unknown): string | null => (isRecord(body) && typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null);

const grantGone = (refreshing: boolean, status: number, code: string | null): boolean => refreshing && (status === 400 || status === 401) && code !== null && SIGN_IN_AGAIN.has(code);

function tokenAnswer(refreshing: boolean, status: number, ok: boolean, body: unknown): OAuthTokens {
  const code = errorCode(body);
  if (grantGone(refreshing, status, code)) throw new OAuthInvalidGrant('That server requires a new sign-in.', 400);
  if (!ok || !isRecord(body)) throw refused(`That server refused to complete the sign-in (${String(status)}${code === null ? '' : ` ${code}`}).`);
  return tokensFrom(body);
}

export function exchangeCode(
  server: OAuthServer,
  client: OAuthClient,
  input: { code: string; redirectUri: string; verifier: string; resource: string },
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokens> {
  return postToken(server, client, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: input.resource,
  }, fetchImpl);
}

export function refreshTokens(
  server: OAuthServer,
  client: OAuthClient,
  refreshToken: string,
  resource: string,
  scope?: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokens> {
  return postToken(server, client, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    resource,
    ...(scope === undefined ? {} : { scope }),
  }, fetchImpl);
}
