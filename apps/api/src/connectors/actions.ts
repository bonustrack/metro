import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorAuth, connectorClient, connectorName } from '@metro-labs/http/connector-input';
import { verifyRemoteMcp, type ConnectorAuth } from '@metro-labs/http/connector-mcp';
import { boundOAuthResource, optionalOAuthResource, parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { discoverPublicOAuth } from '@metro-labs/http/connector-resource';
import { ConnectorUnauthorized, parseConnectorUrl } from '@metro-labs/http/connector-url';
import type { Session } from '@metro-labs/http/workos-token';
import type { ConnectorEvent } from '../db/connector-events.js';
import type { ConnectorRow, OrgConnectorStore } from '../db/connectors.js';
import { connectorView, detailOf, detailText, openConnectorSecret, sealConnectorSecret, type ConnectorDetail, type ConnectorView } from './model.js';
import { beginSignIn, finishSignIn, prepareSignIn, returnToOf, takeHandoff, type SignInDeps, type SignInState } from './sign-in.js';

const CONNECTORS_MAX = 100;
const URL_MAX = 2048;

export interface ActionDeps extends SignInDeps {
  key: () => Buffer | null;
  store: OrgConnectorStore;
}

export interface Caller {
  session: Session;
  owner: string;
}

export interface Created {
  connector: ConnectorView;
  authorizeUrl?: string;
}

const actorOf = (caller: Caller): string => `user:${caller.session.userId}`;

const at = (deps: ActionDeps): string => new Date(deps.now()).toISOString();

export function sealingKey(deps: ActionDeps): Buffer {
  const key = deps.key();
  if (key === null) throw new ApiError('Metro cannot keep connector secrets yet: METRO_CONNECTORS_KEY is not set.', 503);
  return key;
}

function connectorUrl(deps: ActionDeps, raw: unknown): URL {
  const url = deps.httpsOnly ? parsePublicConnectorUrl(raw) : parseConnectorUrl(raw);
  if (url.toString().length > URL_MAX) throw new ApiError('that url is too long', 400);
  if (deps.httpsOnly && url.protocol !== 'https:') throw new ApiError('an organization connector url must start with https://', 400);
  return url;
}

export async function viewOf(deps: ActionDeps, owner: string, id: string): Promise<ConnectorView> {
  const { connectors, assignments } = await deps.store.list(owner);
  const row = connectors.find((c) => c.id === id);
  if (row === undefined) throw new ApiError('no such connector', 404);
  return connectorView(row, assignments);
}

function newRow(caller: Caller, name: string, url: URL, now: string): ConnectorRow {
  return { id: newId(), owner: caller.owner, name, url: url.origin, auth: 'none', authGeneration: newId(), policy: null, secret: null, detail: null, createdBy: caller.session.userId, createdAt: now, updatedAt: now };
}

const createdEvent = (caller: Caller, row: ConnectorRow): ConnectorEvent => ({ owner: caller.owner, connector: row.id, actor: actorOf(caller), action: 'connector.created', detail: { name: row.name, auth: row.auth } });

async function addVerified(deps: ActionDeps, caller: Caller, row: ConnectorRow, auth: ConnectorAuth, server: string, targetUrl: string): Promise<Created> {
  const detail: ConnectorDetail = { server, verifiedAt: row.createdAt, ...(auth.kind === 'header' ? { header: auth.name } : {}) };
  const saved: ConnectorRow = {
    ...row,
    auth: auth.kind,
    secret: sealConnectorSecret(sealingKey(deps), row, auth.kind === 'header' ? { ...auth, targetUrl } : { kind: 'none', targetUrl }),
    detail: detailText(detail),
  };
  await deps.store.create(saved, createdEvent(caller, saved));
  log.info({ owner: caller.owner, id: saved.id, host: new URL(saved.url).hostname, auth: saved.auth }, 'org-connectors: connector added');
  return { connector: connectorView(saved, []) };
}

async function addOAuth(deps: ActionDeps, caller: Caller, row: ConnectorRow, url: URL, body: Record<string, unknown>): Promise<Created> {
  const returnTo = returnToOf(body.returnTo);
  const offered = connectorClient(body.clientId, body.clientSecret);
  const { server, client, resource } = await prepareSignIn(deps, url, offered, body.oauthResource);
  const detail: ConnectorDetail = { issuer: server.issuer, ...(offered === null ? {} : { clientId: offered.clientId }) };
  const saved: ConnectorRow = { ...row, auth: 'oauth', secret: sealConnectorSecret(sealingKey(deps), row, { kind: 'oauth', targetUrl: url.toString(), client, server, oauthResource: resource }), detail: detailText(detail) };
  await deps.store.create(saved, createdEvent(caller, saved));
  const authorizeUrl = beginSignIn(deps, { owner: caller.owner, connector: saved.id, generation: saved.authGeneration ?? '', userId: caller.session.userId, returnTo, targetUrl: url.toString(), resource, configuredResource: resource, server, client });
  log.info({ owner: caller.owner, id: saved.id, host: url.hostname }, 'org-connectors: connector added, sending the admin to sign in');
  return { connector: connectorView(saved, []), authorizeUrl };
}

export async function createConnector(deps: ActionDeps, caller: Caller, body: unknown): Promise<Created> {
  sealingKey(deps);
  const input = isRecord(body) ? body : {};
  const name = connectorName(input.name);
  const url = connectorUrl(deps, input.url);
  const auth = connectorAuth(input.header, input.value);
  connectorClient(input.clientId, input.clientSecret);
  if ((await deps.store.count(caller.owner)) >= CONNECTORS_MAX) throw new ApiError(`An organization keeps at most ${String(CONNECTORS_MAX)} connectors. Remove one first.`, 400);
  const row = newRow(caller, name, url, at(deps));
  try {
    await verifyRemoteMcp(url, auth, deps.fetch);
  } catch (err) {
    if (auth.kind === 'none' && err instanceof ConnectorUnauthorized) return addOAuth(deps, caller, row, url, input);
    throw new ApiError('The provider could not verify the HTTP MCP endpoint. Check its endpoint and authentication settings.', 400);
  }
  return addVerified(deps, caller, row, auth, url.hostname, url.toString());
}

export async function startSignIn(deps: ActionDeps, caller: Caller, id: string, body: unknown): Promise<{ authorizeUrl: string }> {
  const key = sealingKey(deps);
  const input = isRecord(body) ? body : {};
  const returnTo = returnToOf(input.returnTo);
  const before = await deps.store.find(caller.owner, id);
  if (before === null) throw new ApiError('no such connector', 404);
  const secret = openConnectorSecret(key, before);
  if (before.auth !== 'oauth' || secret?.kind !== 'oauth') throw new ApiError('This connector does not sign in with OAuth.', 400);
  const resource = await signInResource(deps, secret, input.oauthResource);
  const generation = newId();
  const row = await deps.store.edit(caller.owner, id, at(deps), (current) => {
    if (current.secret !== before.secret || current.authGeneration !== before.authGeneration) throw new ApiError('The connector changed. Start sign-in again.', 409);
    return { change: { authGeneration: generation }, event: null };
  });
  const authorizeUrl = beginSignIn(deps, { owner: caller.owner, connector: row.id, generation, userId: caller.session.userId, returnTo, targetUrl: secret.targetUrl, resource, configuredResource: secret.oauthResource, server: secret.server, client: secret.client });
  log.info({ owner: caller.owner, id: row.id }, 'org-connectors: sending the admin to sign in again');
  return { authorizeUrl };
}

async function signInResource(deps: ActionDeps, secret: Extract<NonNullable<ReturnType<typeof openConnectorSecret>>, { kind: 'oauth' }>, offered: unknown): Promise<string> {
  const requested = optionalOAuthResource(offered);
  parsePublicConnectorUrl(secret.server.authorizationEndpoint);
  const held = secret.oauthResource ?? secret.tokens?.resource;
  if (held !== undefined) {
    if (requested !== undefined && held !== requested) throw new ApiError('This connector uses a different public OAuth resource. Keep its prepared resource unchanged.', 409);
    return boundOAuthResource(secret.targetUrl, held);
  }
  const discovered = await discoverPublicOAuth(secret.targetUrl, requested, deps.fetch);
  if (discovered.server.issuer !== secret.server.issuer || discovered.server.authorizationEndpoint !== secret.server.authorizationEndpoint || discovered.server.tokenEndpoint !== secret.server.tokenEndpoint) throw new ApiError('The provider’s OAuth configuration changed. Prepare the connector again.', 409);
  return discovered.resource;
}

export async function completeSignIn(deps: ActionDeps, caller: Caller, body: unknown): Promise<ConnectorView> {
  const key = sealingKey(deps);
  const entry = takeHandoff(deps, isRecord(body) ? body.handoff : undefined, caller.session);
  const before = await deps.store.find(caller.owner, entry.connector);
  checkGeneration(before, entry.generation);
  checkSignInTarget(key, before, entry);
  const { tokens, verified } = await finishSignIn(deps, entry);
  const now = at(deps);
  await deps.store.edit(caller.owner, entry.connector, now, (row) => {
    checkGeneration(row, entry.generation);
    const secret = checkSignInTarget(key, row, entry);
    const detail: ConnectorDetail = { ...detailOf(row.detail), issuer: entry.server.issuer, server: verified.server, verifiedAt: now, signedInAt: now };
    return {
      change: { secret: sealConnectorSecret(key, row, { ...secret, tokens: { ...tokens, resource: entry.resource } }), detail: detailText(detail) },
      event: { owner: caller.owner, connector: row.id, actor: actorOf(caller), action: 'connector.signed_in', detail: { name: row.name } },
    };
  });
  log.info({ owner: caller.owner, id: entry.connector }, 'org-connectors: sign-in completed');
  return viewOf(deps, caller.owner, entry.connector);
}

function checkGeneration(row: ConnectorRow | null, generation: string): void {
  if (row === null) throw new ApiError('no such connector', 404);
  if (row.auth !== 'oauth' || row.authGeneration !== generation) throw new ApiError('A newer sign-in replaced this one. Start again from the connector page.', 409);
}

function checkSignInTarget(key: Buffer, row: ConnectorRow | null, entry: SignInState): Extract<NonNullable<ReturnType<typeof openConnectorSecret>>, { kind: 'oauth' }> {
  const secret = row === null ? null : openConnectorSecret(key, row);
  if (secret?.kind !== 'oauth' || secret.targetUrl !== entry.targetUrl || JSON.stringify(secret.client) !== JSON.stringify(entry.client) || JSON.stringify(secret.server) !== JSON.stringify(entry.server) || secret.oauthResource !== entry.configuredResource) throw new ApiError('The connector changed. Start sign-in again.', 409);
  return secret;
}
