import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorAuth, connectorName } from '@metro-labs/http/connector-input';
import { boundOAuthResource, parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { parseConnectorUrl } from '@metro-labs/http/connector-url';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { detailOf, detailText, openConnectorSecret, sealConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { sealingKey } from '@metro-labs/connectors/setup';
import { userMemberships, type UserOrganization, type WorkosConfig } from '../auth/workos.js';
import { at, CONNECTORS_MAX, type ActionDeps, type Caller } from './actions.js';
import { connectorView, type ConnectorView } from './model.js';

export interface CopyDeps extends ActionDeps {
  organizations: (userId: string) => Promise<Pick<UserOrganization, 'id' | 'role'>[]>;
}

export async function copyOrganizations(config: WorkosConfig | null, userId: string): Promise<Pick<UserOrganization, 'id' | 'role'>[]> {
  if (config === null) throw new ApiError('sign-in is not configured on this server', 503);
  try {
    return await userMemberships(config, userId);
  } catch {
    throw new ApiError('Metro could not verify organization admin memberships. Try again.', 503);
  }
}

function inputOf(body: unknown, source: string): { organization: string; name: string } {
  const input = isRecord(body) ? body : {};
  const organization = typeof input.organization === 'string' ? input.organization.trim() : '';
  if (!isOrganizationId(organization)) throw new ApiError('organization must be an organization id', 400);
  if (organization === source) throw new ApiError('Choose another organization for the copy.', 400);
  if (input.shareCredentials !== true) throw new ApiError('Confirm that the destination may use the saved credentials and private URL.', 400);
  return { organization, name: connectorName(input.name) };
}

function signedOut(secret: Extract<ConnectorSecret, { kind: 'oauth' }>): ConnectorSecret {
  const resource = secret.oauthResource ?? (secret.imported === undefined ? secret.tokens?.resource : undefined);
  return {
    kind: 'oauth',
    targetUrl: secret.targetUrl,
    client: secret.client,
    server: secret.server,
    ...(resource === undefined ? {} : { oauthResource: boundOAuthResource(secret.targetUrl, resource) }),
    ...(secret.imported === undefined ? {} : {
      imported: {
        state: 'signin',
        tokenEndpointAuthMethod: secret.imported.tokenEndpointAuthMethod,
        ...(secret.imported.scope === undefined ? {} : { scope: secret.imported.scope }),
      },
    }),
  };
}

function configuration(key: Buffer, source: ConnectorRow, httpsOnly: boolean): ConnectorSecret {
  try {
    const secret = openConnectorSecret(key, source);
    if (secret === null || secret.kind !== source.auth) throw new Error('missing configuration');
    if (httpsOnly) parsePublicConnectorUrl(secret.targetUrl); else parseConnectorUrl(secret.targetUrl);
    if (secret.kind === 'oauth') return signedOut(secret);
    if (secret.kind === 'none') return { kind: 'none', targetUrl: secret.targetUrl };
    const auth = connectorAuth(secret.name, secret.value);
    if (auth.kind !== 'header') throw new Error('missing header');
    return { kind: 'header', targetUrl: secret.targetUrl, name: secret.name, value: secret.value };
  } catch {
    throw new ApiError('The saved connector configuration could not be copied. Set it up again before copying.', 409);
  }
}

function copiedRow(key: Buffer, source: ConnectorRow, caller: Caller, input: { organization: string; name: string }, now: string, httpsOnly: boolean): ConnectorRow {
  const secret = configuration(key, source, httpsOnly);
  const url = new URL(secret.targetUrl);
  const clientId = detailOf(source.detail).clientId;
  const detail = secret.kind === 'oauth'
    ? { ...(clientId === undefined ? {} : { clientId }) }
    : { server: url.hostname, ...(secret.kind === 'header' ? { header: secret.name } : {}) };
  const row: ConnectorRow = {
    id: newId(),
    owner: input.organization,
    name: input.name,
    url: url.origin,
    auth: secret.kind,
    authGeneration: newId(),
    policy: source.policy,
    secret: null,
    detail: detailText(detail),
    createdBy: caller.session.userId,
    createdAt: now,
    updatedAt: now,
  };
  return { ...row, secret: sealConnectorSecret(key, row, secret) };
}

export async function copyConnector(deps: CopyDeps, caller: Caller, id: string, body: unknown): Promise<{ organization: string; connector: ConnectorView }> {
  const input = inputOf(body, caller.owner);
  const memberships = await deps.organizations(caller.session.userId);
  const admins = new Set(memberships.filter((membership) => membership.role === 'admin').map((membership) => membership.id));
  if (!admins.has(caller.owner) || !admins.has(input.organization)) throw new ApiError('Copying a connector needs active admin membership in both organizations.', 403);
  const key = sealingKey(deps);
  if ((await deps.store.count(input.organization)) >= CONNECTORS_MAX) throw new ApiError(`An organization keeps at most ${String(CONNECTORS_MAX)} connectors. Remove one first.`, 400);
  const now = at(deps);
  const row = await deps.store.copy(caller.owner, id, (source) => copiedRow(key, source, caller, input, now, deps.httpsOnly));
  return { organization: input.organization, connector: connectorView(row, []) };
}
