import type { ConnectorAuth } from '@metro-labs/http/connector-mcp';
import { parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { ConnectorUnauthorized } from '@metro-labs/http/connector-url';
import { connectorAuthOf } from '@metro-labs/connectors/catalogue';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { openConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { refreshConnector } from '@metro-labs/connectors/refresh';
import { credentialRevision } from '@metro-labs/connectors/revision';
import type { McpDeps } from './deps.js';
import { CallError } from './errors.js';

export interface VendorTarget {
  url: URL;
  auth: ConnectorAuth;
  secret: ConnectorSecret;
  revision: string;
}

type OAuthSecret = Extract<ConnectorSecret, { kind: 'oauth' }>;
type CredentialDeps = Pick<McpDeps, 'key' | 'store' | 'fetch' | 'now' | 'refreshes'>;

export const signinError = (name: string): CallError => new CallError('signin', `${name} needs to be signed in again on metro.box (Connectors), so Metro cannot use it now.`);
const unavailableError = (name: string): CallError => new CallError('unavailable', `${name} cannot be used right now. Try again in a few minutes.`);
const missingError = (): CallError => new CallError('not_found', 'That connector is no longer assigned to this agent.');

const expired = (secret: OAuthSecret, now: number): boolean => secret.tokens?.expiresAt !== undefined && secret.tokens.expiresAt <= now;

function needsRefresh(secret: ConnectorSecret | null, now: number): boolean {
  if (secret?.kind !== 'oauth' || secret.tokens === undefined) return false;
  if (secret.imported !== undefined) return secret.imported.state === 'owned' && expired(secret, now);
  return secret.tokens.resource === undefined || expired(secret, now);
}

function opened(deps: CredentialDeps, row: ConnectorRow): ConnectorSecret | null {
  try {
    return openConnectorSecret(deps.key, row);
  } catch {
    return null;
  }
}

async function currentRow(deps: CredentialDeps, identity: DeliveryIdentity, connectorId: string): Promise<ConnectorRow> {
  const row = (await deps.store.assigned(identity)).find((assigned) => assigned.connector.id === connectorId);
  if (row === undefined) throw missingError();
  return row.connector;
}

function checkOAuth(secret: OAuthSecret, name: string, now: number): void {
  if (secret.imported !== undefined && secret.imported.state !== 'owned') throw secret.imported.state === 'signin' ? signinError(name) : unavailableError(name);
  if (secret.tokens?.resource === undefined) throw signinError(name);
  if (expired(secret, now)) throw secret.tokens.refreshToken === undefined ? signinError(name) : unavailableError(name);
}

function targetOf(deps: CredentialDeps, row: ConnectorRow): VendorTarget {
  const secret = opened(deps, row);
  if (secret === null || secret.kind !== row.auth) throw unavailableError(row.name);
  if (secret.kind === 'oauth') checkOAuth(secret, row.name, deps.now());
  let url: URL;
  try {
    url = parsePublicConnectorUrl(secret.targetUrl);
  } catch {
    throw unavailableError(row.name);
  }
  return { url, auth: connectorAuthOf(secret), secret, revision: credentialRevision(deps.key, row) };
}

async function refreshed(deps: CredentialDeps, identity: DeliveryIdentity, connectorId: string, forced?: string): Promise<void> {
  await deps.refreshes.run(`${connectorId}:${forced ?? ''}`, async () => {
    await refreshConnector(deps, identity, connectorId, forced === undefined ? undefined : { connectorId, revision: forced });
    return undefined;
  });
}

export async function vendorTarget(deps: CredentialDeps, identity: DeliveryIdentity, connectorId: string, forced?: string): Promise<VendorTarget> {
  let row = await currentRow(deps, identity, connectorId);
  if (forced !== undefined || needsRefresh(opened(deps, row), deps.now())) {
    await refreshed(deps, identity, connectorId, forced);
    row = await currentRow(deps, identity, connectorId);
  }
  return targetOf(deps, row);
}

export async function withCredential<T>(deps: CredentialDeps, identity: DeliveryIdentity, connectorId: string, work: (target: VendorTarget) => Promise<T>): Promise<T> {
  const first = await vendorTarget(deps, identity, connectorId);
  try {
    return await work(first);
  } catch (err) {
    if (!(err instanceof ConnectorUnauthorized)) throw err;
  }
  const name = (await currentRow(deps, identity, connectorId)).name;
  if (first.secret.kind !== 'oauth') throw signinError(name);
  const second = await vendorTarget(deps, identity, connectorId, first.revision);
  if (second.revision === first.revision) throw signinError(name);
  try {
    return await work(second);
  } catch (err) {
    if (err instanceof ConnectorUnauthorized) throw signinError(name);
    throw err;
  }
}
