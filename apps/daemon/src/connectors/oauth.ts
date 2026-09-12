import { publicBaseOrDefault } from '../files/attach-serve.js';
import {
  ConnectorVerifyError,
  type OAuthAuth,
  type OAuthTokens,
} from './verify.js';
import { validateReturnTo } from '@metro-labs/http/return-to';
import {
  authorizeUrl,
  exchangeCode,
  newVerifier,
  refreshTokens,
  registerClient,
  type OAuthClient,
} from './oauth-client.js';
import { discoverOAuth, type OAuthServer } from './oauth-discovery.js';
import { startPending, takePending, type PendingAuth } from './oauth-pending.js';

export { takePending, type PendingAuth };

const REFRESH_SKEW_MS = 300_000;

const CALLBACK_PATH = '/api/connectors/callback';

const callbackUri = (): string =>
  `${publicBaseOrDefault()}${CALLBACK_PATH}`;

function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

const resourceOf = (url: URL): string => url.toString();

export interface PrepareInput {
  url: URL;
  client: OAuthClient | null;
  returnTo: string;
}

export interface PreparedOAuth {
  server: OAuthServer;
  client: OAuthClient;
  redirectUri: string;
}

export async function prepareOAuth(input: PrepareInput): Promise<PreparedOAuth> {
  if (!validateReturnTo(input.returnTo))
    throw refused('that return address is not one Metro will send you back to');
  const server = await discoverOAuth(input.url);
  const redirectUri = callbackUri();
  const client = input.client ?? (await registerClient(server, redirectUri));
  return { server, client, redirectUri };
}

export interface BeginInput {
  connectorId: string;
  subject: string;
  name: string;
  url: URL;
  returnTo: string;
}

export function beginOAuth(prepared: PreparedOAuth, input: BeginInput): string {
  const { server, client, redirectUri } = prepared;
  const verifier = newVerifier();
  const resource = resourceOf(input.url);
  const state = startPending({
    subject: input.subject,
    name: input.name,
    url: input.url.toString(),
    resource,
    returnTo: input.returnTo,
    verifier,
    server,
    client,
    connectorId: input.connectorId,
  });
  return authorizeUrl({
    server,
    client,
    redirectUri,
    state,
    verifier,
    resource,
  });
}

function authOf(pendingAuth: PendingAuth, tokens: OAuthTokens): OAuthAuth {
  return {
    kind: 'oauth',
    issuer: pendingAuth.server.issuer,
    tokenEndpoint: pendingAuth.server.tokenEndpoint,
    clientId: pendingAuth.client.clientId,
    ...(pendingAuth.client.clientSecret === undefined
      ? {}
      : { clientSecret: pendingAuth.client.clientSecret }),
    ...(pendingAuth.server.scopes.length === 0
      ? {}
      : { scope: pendingAuth.server.scopes.join(' ') }),
    ...tokens,
  };
}

export async function completeOAuth(
  entry: PendingAuth,
  code: string,
): Promise<OAuthAuth> {
  const tokens = await exchangeCode(entry.server, entry.client, {
    code,
    redirectUri: callbackUri(),
    verifier: entry.verifier,
    resource: entry.resource,
  });
  return authOf(entry, tokens);
}

export function oauthExpired(auth: OAuthAuth, now = Date.now()): boolean {
  return auth.expiresAt !== undefined && auth.expiresAt - REFRESH_SKEW_MS <= now;
}

export async function refreshOAuth(
  auth: OAuthAuth,
  resource: string,
): Promise<OAuthAuth> {
  if (auth.refreshToken === undefined)
    throw refused('that connector needs signing in again');
  const server = {
    issuer: auth.issuer,
    authorizationEndpoint: '',
    tokenEndpoint: auth.tokenEndpoint,
    registrationEndpoint: null,
    supportsS256: true,
    scopes: [],
  };
  const client = {
    clientId: auth.clientId,
    ...(auth.clientSecret === undefined
      ? {}
      : { clientSecret: auth.clientSecret }),
  };
  const tokens = await refreshTokens(
    server,
    client,
    auth.refreshToken,
    resource,
    auth.scope,
  );
  return {
    ...auth,
    ...tokens,
    ...(tokens.refreshToken === undefined
      ? { refreshToken: auth.refreshToken }
      : {}),
  };
}
