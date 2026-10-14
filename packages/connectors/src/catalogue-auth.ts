import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { OAuthInvalidGrant, refreshTokens } from '@metro-labs/http/connector-oauth';
import type { ConnectorChange, ConnectorRow, OrgConnectorStore } from './db/connectors.js';
import { credentialRevision } from './revision.js';
import { refreshImported } from './imported-refresh.js';
import { detailOf, detailText, openConnectorSecret, sealConnectorSecret, type ConnectorSecret } from './model.js';
import { sealingKey } from './setup.js';

type OAuthSecret = Extract<ConnectorSecret, { kind: 'oauth' }>;

export interface CatalogueDeps {
  key: () => Buffer | null;
  store: Pick<OrgConnectorStore, 'find' | 'edit'>;
  fetch: FetchLike;
  now: () => number;
}

export const catalogueSignin = (): ApiError => new ApiError('Sign in to this connector again to load its tools.', 424);
export const catalogueUnavailable = (): ApiError => new ApiError('The provider could not return its tool list. Try again.', 503);

function checkCatalogueGrant(secret: OAuthSecret, now: number): void {
  if (secret.imported?.state === 'refreshing') throw catalogueUnavailable();
  if (secret.imported !== undefined && secret.imported.state !== 'owned') throw catalogueSignin();
  if (secret.tokens?.resource === undefined || (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= now)) throw catalogueSignin();
}

export function catalogueSecret(key: Buffer, row: ConnectorRow, now: number): ConnectorSecret {
  const secret = openConnectorSecret(key, row);
  if (secret === null || secret.kind !== row.auth) throw catalogueUnavailable();
  if (secret.kind === 'oauth') checkCatalogueGrant(secret, now);
  return secret;
}

function clearGrant(key: Buffer, row: ConnectorRow, secret: OAuthSecret): ConnectorChange {
  const retained = { ...secret };
  delete retained.tokens;
  const detail = detailOf(row.detail);
  delete detail.signedInAt;
  return { secret: sealConnectorSecret(key, row, retained), detail: detailText(detail) };
}

function nativeRefresh(secret: OAuthSecret, revision: string, now: number, forced?: string): boolean {
  if (secret.imported !== undefined || secret.tokens?.resource === undefined) return false;
  return forced === undefined ? secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= now : revision === forced;
}

async function refreshedGrant(deps: CatalogueDeps, key: Buffer, row: ConnectorRow, secret: OAuthSecret): Promise<ConnectorChange> {
  const tokens = secret.tokens;
  if (tokens?.resource === undefined || tokens.refreshToken === undefined) throw catalogueSignin();
  const scope = secret.server.scopes.length === 0 ? undefined : secret.server.scopes.join(' ');
  const refreshed = await refreshTokens(secret.server, secret.client, tokens.refreshToken, tokens.resource, scope, deps.fetch);
  const next = { ...refreshed, resource: tokens.resource, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
  return { secret: sealConnectorSecret(key, row, { ...secret, tokens: next }) };
}

export async function catalogueCredential(deps: CatalogueDeps, owner: string, id: string, forced?: string): Promise<ConnectorRow> {
  const key = sealingKey(deps);
  const at = (): string => new Date(deps.now()).toISOString();
  await refreshImported({ key, fetch: deps.fetch, now: deps.now }, async (edit) => {
    await deps.store.edit(owner, id, at(), edit);
  }, forced);
  const state: { error?: ApiError } = {};
  const row = await deps.store.edit(owner, id, at(), async (current) => {
    const secret = openConnectorSecret(key, current);
    if (secret?.kind !== 'oauth' || !nativeRefresh(secret, credentialRevision(key, current), deps.now(), forced)) return { change: {} };
    try {
      return { change: await refreshedGrant(deps, key, current, secret) };
    } catch (err) {
      const invalid = err instanceof OAuthInvalidGrant;
      state.error = invalid || (err instanceof ApiError && err.status === 424) ? catalogueSignin() : catalogueUnavailable();
      return { change: invalid ? clearGrant(key, current, secret) : {} };
    }
  });
  if (state.error !== undefined) throw state.error;
  catalogueSecret(key, row, deps.now());
  return row;
}
