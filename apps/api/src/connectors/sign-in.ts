import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import type { OAuthServer } from '@metro-labs/http/connector-discovery';
import { discoverPublicOAuth } from '@metro-labs/http/connector-resource';
import { boundOAuthResource, parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { verifyRemoteMcp, type OAuthTokens, type VerifiedServer } from '@metro-labs/http/connector-mcp';
import { authorizeUrl, exchangeCode, newVerifier, registerClient, type OAuthClient } from '@metro-labs/http/connector-oauth';
import { isAppReturn, validateReturnTo } from '@metro-labs/http/return-to';
import type { Session } from '@metro-labs/http/workos-token';
import type { OwnerTickets } from '../agents/tickets.js';

export interface SignInState {
  owner: string;
  connector: string;
  generation: string;
  userId: string;
  verifier: string;
  returnTo: string;
  resource: string;
  targetUrl: string;
  configuredResource?: string;
  server: OAuthServer;
  client: OAuthClient;
  storedClient?: OAuthClient;
}

export interface Handoff extends SignInState {
  code: string;
}

export interface SignInDeps {
  fetch: FetchLike;
  httpsOnly: boolean;
  callbackUrl: string;
  states: OwnerTickets<SignInState>;
  handoffs: OwnerTickets<Handoff>;
  now: () => number;
}

interface Prepared {
  resource: string;
  server: OAuthServer;
  client: OAuthClient;
}

const expired = (): ApiError => new ApiError('This sign-in has expired. Start it again from the Connectors page.', 400);

export function returnToOf(raw: unknown): string {
  const returnTo = typeof raw === 'string' ? raw.trim() : '';
  if (isAppReturn(returnTo) || !validateReturnTo(returnTo)) throw new ApiError('that return address is not one Metro will send you back to', 400);
  return returnTo;
}

export async function registeredClient(deps: SignInDeps, server: OAuthServer): Promise<OAuthClient> {
  return { ...(await registerClient(server, deps.callbackUrl, deps.fetch)), redirectUri: deps.callbackUrl };
}

export async function currentClient(deps: SignInDeps, server: OAuthServer, client: OAuthClient): Promise<OAuthClient> {
  if (client.redirectUri === deps.callbackUrl || client.clientSecret !== undefined || server.registrationEndpoint === null) return client;
  try {
    return await registeredClient(deps, server);
  } catch {
    throw new ApiError('The provider could not register an OAuth client. Check its client registration and the central callback URL.', 400);
  }
}

export async function prepareSignIn(deps: SignInDeps, url: URL, client: OAuthClient | null, offeredResource?: unknown): Promise<Prepared> {
  const { server, resource } = await discoverPublicOAuth(url.toString(), offeredResource, deps.fetch);
  try {
    return { server, resource, client: client === null ? await registeredClient(deps, server) : { ...client, redirectUri: deps.callbackUrl } };
  } catch {
    throw new ApiError('The provider could not register an OAuth client. Check its client registration and the central callback URL.', 400);
  }
}

export function beginSignIn(deps: SignInDeps, state: Omit<SignInState, 'verifier'>): string {
  boundOAuthResource(state.targetUrl, state.resource);
  parsePublicConnectorUrl(state.server.authorizationEndpoint);
  const verifier = newVerifier();
  const { ticket } = deps.states.mint({ ...state, verifier }, deps.now());
  return authorizeUrl({ server: state.server, client: state.client, redirectUri: deps.callbackUrl, state: ticket, verifier, resource: state.resource });
}

function pageAddress(entry: SignInState, param: string, value: string): string {
  const url = new URL(entry.returnTo);
  url.search = '';
  url.hash = `#/${entry.owner}/organization/connectors/${entry.connector}?${new URLSearchParams({ [param]: value }).toString()}`;
  return url.toString();
}

function refusal(error: string): string {
  return error === 'access_denied' ? 'The sign-in was declined, so nothing changed.' : 'The provider refused the sign-in. Check the public OAuth resource and client registration, then try again.';
}

export function callbackLocation(deps: SignInDeps, query: URLSearchParams): string {
  const now = deps.now();
  const entry = deps.states.take(query.get('state') ?? '', now);
  if (entry === undefined) throw expired();
  const error = query.get('error');
  const code = query.get('code') ?? '';
  if (error !== null || code === '') return pageAddress(entry, 'org_connector_error', refusal(error ?? 'no_code'));
  const { ticket } = deps.handoffs.mint({ ...entry, code }, now);
  return pageAddress(entry, 'org_connector', ticket);
}

export function takeHandoff(deps: SignInDeps, raw: unknown, session: Session): Handoff {
  const ticket = typeof raw === 'string' ? raw : '';
  const entry = deps.handoffs.peek(ticket, deps.now());
  if (entry === undefined) throw expired();
  if (entry.owner !== session.organization || entry.userId !== session.userId) throw new ApiError('This sign-in was started by someone else, so it cannot finish here.', 403);
  if (deps.handoffs.take(ticket, deps.now()) === undefined) throw expired();
  return entry;
}

export async function finishSignIn(deps: SignInDeps, entry: Handoff): Promise<{ tokens: OAuthTokens; verified: VerifiedServer }> {
  try {
    const tokens = await exchangeCode(entry.server, entry.client, { code: entry.code, redirectUri: deps.callbackUrl, verifier: entry.verifier, resource: entry.resource }, deps.fetch);
    const auth = { kind: 'oauth' as const, issuer: entry.server.issuer, tokenEndpoint: entry.server.tokenEndpoint, clientId: entry.client.clientId, ...tokens };
    const target = parsePublicConnectorUrl(entry.targetUrl);
    await verifyRemoteMcp(target, auth, deps.fetch);
    return { tokens, verified: { server: target.hostname } };
  } catch {
    throw new ApiError('The provider could not complete sign-in or verify the MCP endpoint. Check its public OAuth resource and client registration, then sign in again.', 400);
  }
}
