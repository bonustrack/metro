import { newId } from '@metro-labs/core/ids';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { OAuthInvalidGrant, refreshTokens } from '@metro-labs/http/connector-oauth';
import type { ConnectorEdit, ConnectorRow } from '../db/connectors.js';
import { credentialRevision } from './delivery-model.js';
import { openConnectorSecret, sealConnectorSecret, type ConnectorSecret } from './model.js';

type OAuthSecret = Extract<ConnectorSecret, { kind: 'oauth' }>;
export type RefreshLock = (edit: (row: ConnectorRow) => Promise<ConnectorEdit>) => Promise<void>;
interface Deps { key: Buffer; now: () => number; fetch: FetchLike }
const unchanged = (): ConnectorEdit => ({ change: {}, event: null });
const save = (key: Buffer, row: ConnectorRow, secret: OAuthSecret): ConnectorEdit => ({ change: { secret: sealConnectorSecret(key, row, secret) }, event: null });

function needsRefresh(deps: Deps, row: ConnectorRow, secret: OAuthSecret, forced?: string): boolean {
  if (secret.imported?.state !== 'owned' || secret.tokens?.refreshToken === undefined || secret.tokens.resource === undefined) return false;
  if (forced !== undefined) return credentialRevision(deps.key, row) === forced;
  return secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= deps.now();
}

async function perform(deps: Deps, row: ConnectorRow, secret: OAuthSecret): Promise<ConnectorEdit> {
  const { imported, tokens } = secret;
  if (imported === undefined || tokens?.refreshToken === undefined || tokens.resource === undefined) return unchanged();
  try {
    const refreshed = await refreshTokens(secret.server, secret.client, tokens.refreshToken, tokens.resource, imported.scope, deps.fetch);
    return save(deps.key, row, {
      ...secret,
      imported: { state: 'owned', tokenEndpointAuthMethod: imported.tokenEndpointAuthMethod, ...(imported.scope === undefined ? {} : { scope: imported.scope }) },
      tokens: { ...refreshed, resource: tokens.resource, refreshToken: refreshed.refreshToken ?? tokens.refreshToken },
    });
  } catch (error) {
    return save(deps.key, row, { ...secret, imported: { ...imported, state: error instanceof OAuthInvalidGrant ? 'signin' : 'uncertain' } });
  }
}

export async function refreshImported(deps: Deps, lock: RefreshLock, forced?: string): Promise<void> {
  let attempt: string | null = null;
  await lock((row) => {
    const secret = openConnectorSecret(deps.key, row);
    if (secret?.kind !== 'oauth' || secret.imported === undefined || !needsRefresh(deps, row, secret, forced)) return Promise.resolve(unchanged());
    attempt = newId();
    return Promise.resolve(save(deps.key, row, { ...secret, imported: { ...secret.imported, state: 'refreshing', attempt } }));
  });
  if (attempt === null) return;
  await lock(async (row) => {
    const secret = openConnectorSecret(deps.key, row);
    if (secret?.kind !== 'oauth' || secret.imported?.state !== 'refreshing' || secret.imported.attempt !== attempt) return unchanged();
    return perform(deps, row, secret);
  });
}
