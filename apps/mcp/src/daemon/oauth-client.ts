import { createHash, randomBytes } from 'node:crypto';
import {
  ConnectorVerifyError,
  type OAuthTokens,
} from './connector-verify.js';
import type { OAuthServer } from './oauth-discovery.js';

const TOKEN_TIMEOUT_MS = 15_000;
const CLIENT_NAME = 'Metro';

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
): Promise<OAuthClient> {
  if (server.registrationEndpoint === null)
    throw refused(
      'That server requires OAuth but does not accept client registration, so Metro cannot sign in to it.',
    );
  let res: Response;
  try {
    res = await fetch(server.registrationEndpoint, {
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
  } catch {
    throw refused('Metro could not reach that server to register.');
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
  return url.toString();
}

function tokensFrom(body: Record<string, unknown>): OAuthTokens {
  const access = body.access_token;
  if (typeof access !== 'string' || access === '')
    throw refused('That server did not return an access token.');
  const refresh = body.refresh_token;
  const expires = body.expires_in;
  return {
    accessToken: access,
    ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}),
    ...(typeof expires === 'number'
      ? { expiresAt: Date.now() + expires * 1000 }
      : {}),
  };
}

async function postToken(
  server: OAuthServer,
  client: OAuthClient,
  form: Record<string, string>,
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
    res = await fetch(server.tokenEndpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    });
  } catch {
    throw refused('Metro could not reach that server to finish signing in.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body))
    throw refused('That server refused to complete the sign-in.');
  return tokensFrom(body);
}

export function exchangeCode(
  server: OAuthServer,
  client: OAuthClient,
  input: { code: string; redirectUri: string; verifier: string; resource: string },
): Promise<OAuthTokens> {
  return postToken(server, client, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: input.resource,
  });
}

export function refreshTokens(
  server: OAuthServer,
  client: OAuthClient,
  refreshToken: string,
  resource: string,
): Promise<OAuthTokens> {
  return postToken(server, client, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    resource,
  });
}
