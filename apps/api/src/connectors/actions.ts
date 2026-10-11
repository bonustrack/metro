import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorAuth, connectorClient, connectorName } from '@metro-labs/http/connector-input';
import { verifyRemoteMcp, type ConnectorAuth } from '@metro-labs/http/connector-mcp';
import { ConnectorUnauthorized, parseConnectorUrl } from '@metro-labs/http/connector-url';
import type { Session } from '@metro-labs/http/workos-token';
import type { ConnectorEvent } from '../db/connector-events.js';
import type { ConnectorRow, OrgConnectorStore } from '../db/connectors.js';
import { connectorView, detailOf, detailText, openConnectorSecret, sealConnectorSecret, type ConnectorDetail, type ConnectorView } from './model.js';
import { beginSignIn, finishSignIn, prepareSignIn, returnToOf, takeHandoff, type SignInDeps } from './sign-in.js';

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
  const url = parseConnectorUrl(raw);
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
  const { server, client } = await prepareSignIn(deps, url, offered);
  const detail: ConnectorDetail = { issuer: server.issuer, ...(offered === null ? {} : { clientId: offered.clientId }) };
  const saved: ConnectorRow = { ...row, auth: 'oauth', secret: sealConnectorSecret(sealingKey(deps), row, { kind: 'oauth', targetUrl: url.toString(), client, server }), detail: detailText(detail) };
  await deps.store.create(saved, createdEvent(caller, saved));
  const authorizeUrl = beginSignIn(deps, { owner: caller.owner, connector: saved.id, generation: saved.authGeneration ?? '', userId: caller.session.userId, returnTo, resource: url.toString(), server, client });
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
    const verified = await verifyRemoteMcp(url, auth, deps.fetch);
    return await addVerified(deps, caller, row, auth, verified.server, url.toString());
  } catch (err) {
    if (auth.kind !== 'none' || !(err instanceof ConnectorUnauthorized)) throw err;
  }
  return addOAuth(deps, caller, row, url, input);
}

export async function startSignIn(deps: ActionDeps, caller: Caller, id: string, body: unknown): Promise<{ authorizeUrl: string }> {
  const key = sealingKey(deps);
  const returnTo = returnToOf(isRecord(body) ? body.returnTo : undefined);
  const generation = newId();
  const row = await deps.store.edit(caller.owner, id, at(deps), (current) => {
    if (current.auth !== 'oauth') throw new ApiError('This connector does not sign in with OAuth.', 400);
    return { change: { authGeneration: generation }, event: null };
  });
  const secret = openConnectorSecret(key, row);
  if (secret?.kind !== 'oauth') throw new ApiError('This connector does not sign in with OAuth.', 400);
  const authorizeUrl = beginSignIn(deps, { owner: caller.owner, connector: row.id, generation, userId: caller.session.userId, returnTo, resource: secret.targetUrl, server: secret.server, client: secret.client });
  log.info({ owner: caller.owner, id: row.id }, 'org-connectors: sending the admin to sign in again');
  return { authorizeUrl };
}

export async function completeSignIn(deps: ActionDeps, caller: Caller, body: unknown): Promise<ConnectorView> {
  const key = sealingKey(deps);
  const entry = takeHandoff(deps, isRecord(body) ? body.handoff : undefined, caller.session);
  const before = await deps.store.find(caller.owner, entry.connector);
  checkGeneration(before, entry.generation);
  const { tokens, verified } = await finishSignIn(deps, entry);
  const now = at(deps);
  await deps.store.edit(caller.owner, entry.connector, now, (row) => {
    checkGeneration(row, entry.generation);
    const detail: ConnectorDetail = { ...detailOf(row.detail), issuer: entry.server.issuer, server: verified.server, verifiedAt: now, signedInAt: now };
    return {
      change: { secret: sealConnectorSecret(key, row, { kind: 'oauth', targetUrl: entry.resource, client: entry.client, server: entry.server, tokens }), detail: detailText(detail) },
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
