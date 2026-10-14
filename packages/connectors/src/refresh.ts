import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { OAuthInvalidGrant, refreshTokens } from '@metro-labs/http/connector-oauth';
import type { AgentKeyRow } from './db/agent-keys.js';
import type { AssignedConnector, ConnectorDeliveryStore } from './db/connector-delivery.js';
import type { ConnectorEdit, ConnectorRow } from './db/connectors.js';
import { refreshImported } from './imported-refresh.js';
import { credentialRevision, deliveryPolicy } from './revision.js';
import { detailOf, detailText, openConnectorSecret, sealConnectorSecret, type ConnectorSecret } from './model.js';

export interface RefreshRequest {
  connectorId: string;
  revision: string;
}

export interface RefreshDeps {
  key: Buffer;
  store: Pick<ConnectorDeliveryStore, 'assigned' | 'refresh'>;
  fetch: FetchLike;
  now: () => number;
}

const REFRESH_DEADLINE_MS = 45_000;

const unchanged = (): ConnectorEdit => ({ change: {} });

type OAuthSecret = Extract<ConnectorSecret, { kind: 'oauth' }>;

function failedRefresh(deps: RefreshDeps, row: ConnectorRow, secret: OAuthSecret, err: unknown): ConnectorEdit {
  if (!(err instanceof OAuthInvalidGrant)) return unchanged();
  return disconnected(deps, row, secret);
}

function disconnected(deps: RefreshDeps, row: ConnectorRow, secret: OAuthSecret): ConnectorEdit {
  const detail = detailOf(row.detail);
  delete detail.signedInAt;
  const retained: OAuthSecret = { kind: 'oauth', targetUrl: secret.targetUrl, client: secret.client, server: secret.server, ...(secret.oauthResource === undefined ? {} : { oauthResource: secret.oauthResource }) };
  return { change: { secret: sealConnectorSecret(deps.key, row, retained), detail: detailText(detail) } };
}

async function refreshLocked(deps: RefreshDeps, assigned: AssignedConnector, forced: RefreshRequest | undefined, failed: Map<string, string>): Promise<ConnectorEdit> {
  const row = assigned.connector;
  const { valid, blocked } = deliveryPolicy(assigned);
  if (row.auth !== 'oauth' || !valid || blocked) return unchanged();
  const revision = credentialRevision(deps.key, row);
  if (forced !== undefined && forced.revision !== revision) return unchanged();
  const secret = openConnectorSecret(deps.key, row);
  if (secret?.kind !== 'oauth' || secret.imported !== undefined) return unchanged();
  return refreshSecret(deps, row, secret, forced, failed);
}

async function refreshSecret(deps: RefreshDeps, row: ConnectorRow, secret: OAuthSecret, forced: RefreshRequest | undefined, failed: Map<string, string>): Promise<ConnectorEdit> {
  const { tokens } = secret;
  if (tokens === undefined) return unchanged();
  if (tokens.resource === undefined) return disconnected(deps, row, secret);
  const revision = credentialRevision(deps.key, row);
  if (forced === undefined && (tokens.expiresAt === undefined || tokens.expiresAt > deps.now())) return unchanged();
  if (tokens.refreshToken === undefined) {
    if (forced !== undefined) failed.set(row.id, revision);
    return unchanged();
  }
  return refreshedEdit(deps, row, secret, tokens.refreshToken, tokens.resource, failed);
}

async function refreshedEdit(deps: RefreshDeps, row: ConnectorRow, secret: OAuthSecret, refreshToken: string, resource: string, failed: Map<string, string>): Promise<ConnectorEdit> {
  try {
    const scope = secret.server.scopes.length === 0 ? undefined : secret.server.scopes.join(' ');
    const refreshed = await refreshTokens(secret.server, secret.client, refreshToken, resource, scope, deps.fetch);
    const next = { ...refreshed, resource, refreshToken: refreshed.refreshToken ?? refreshToken };
    return { change: { secret: sealConnectorSecret(deps.key, row, { ...secret, tokens: next }) } };
  } catch (err) {
    if (!(err instanceof OAuthInvalidGrant)) failed.set(row.id, credentialRevision(deps.key, row));
    return failedRefresh(deps, row, secret, err);
  }
}

function bounded(deps: RefreshDeps): { deps: RefreshDeps; deadline: AbortSignal } {
  const deadline = AbortSignal.timeout(REFRESH_DEADLINE_MS);
  return { deadline, deps: { ...deps, fetch: (url, init) => deps.fetch(url, { ...init, signal: init?.signal === undefined || init.signal === null ? deadline : AbortSignal.any([deadline, init.signal]) }) } };
}

async function refreshOne(deps: RefreshDeps, identity: AgentKeyRow, connectorId: string, forced: RefreshRequest | undefined, failed: Map<string, string>): Promise<void> {
  await refreshImported(deps, async (edit) => {
    await deps.store.refresh(identity, connectorId, new Date(deps.now()).toISOString(), async (current) => {
      const { valid, blocked } = deliveryPolicy(current);
      if (!valid || blocked) return unchanged();
      return edit(current.connector);
    });
  }, forced?.revision);
  await deps.store.refresh(identity, connectorId, new Date(deps.now()).toISOString(), (current) => refreshLocked(deps, current, forced, failed));
}

export async function refreshConnector(deps: RefreshDeps, identity: AgentKeyRow, connectorId: string, forced?: RefreshRequest): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  await refreshOne(bounded(deps).deps, identity, connectorId, forced?.connectorId === connectorId ? forced : undefined, failed);
  return failed;
}

export async function refreshAssigned(deps: RefreshDeps, identity: AgentKeyRow, forced?: RefreshRequest): Promise<Map<string, string>> {
  const rows = await deps.store.assigned(identity);
  if (forced !== undefined) rows.sort((left, right) => Number(right.connector.id === forced.connectorId) - Number(left.connector.id === forced.connectorId));
  const failed = new Map<string, string>();
  const limited = bounded(deps);
  for (const { connector } of rows) {
    if (limited.deadline.aborted) break;
    if (connector.auth !== 'oauth') continue;
    await refreshOne(limited.deps, identity, connector.id, forced?.connectorId === connector.id ? forced : undefined, failed);
  }
  return failed;
}
