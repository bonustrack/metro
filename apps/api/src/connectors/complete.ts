import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { AUTO_NAMED, detailOf, detailText, openConnectorSecret, sealConnectorSecret, type ConnectorDetail, type ConnectorSecret } from '@metro-labs/connectors/model';
import { sealingKey } from '@metro-labs/connectors/setup';
import { at, CONNECTORS_MAX, viewOf, type ActionDeps, type Caller } from './actions.js';
import type { ConnectorView } from './model.js';
import { accountName, isAutoNamed } from './naming.js';
import { finishSignIn, takeHandoff, type Handoff, type NewConnector, type SignInState } from './sign-in.js';

type OAuthSecret = Extract<ConnectorSecret, { kind: 'oauth' }>;

function checkGeneration(row: ConnectorRow | null, generation: string): void {
  if (row === null) throw new ApiError('no such connector', 404);
  if (row.auth !== 'oauth' || row.authGeneration !== generation) throw new ApiError('A newer sign-in replaced this one. Start again from the connector page.', 409);
}

function checkSignInTarget(key: Buffer, row: ConnectorRow | null, entry: SignInState): OAuthSecret {
  const secret = row === null ? null : openConnectorSecret(key, row);
  if (secret?.kind !== 'oauth' || secret.targetUrl !== entry.targetUrl || JSON.stringify(secret.client) !== JSON.stringify(entry.storedClient ?? entry.client) || JSON.stringify(secret.server) !== JSON.stringify(entry.server) || secret.oauthResource !== entry.configuredResource) throw new ApiError('The connector changed. Start sign-in again.', 409);
  return secret;
}

async function completeNew(deps: ActionDeps, caller: Caller, key: Buffer, entry: Handoff, create: NewConnector): Promise<ConnectorView> {
  if ((await deps.store.count(caller.owner)) >= CONNECTORS_MAX) throw new ApiError(`An organization keeps at most ${String(CONNECTORS_MAX)} connectors. Remove one first.`, 400);
  const { tokens, verified } = await finishSignIn(deps, entry);
  const now = at(deps);
  const secret: OAuthSecret = {
    kind: 'oauth',
    targetUrl: entry.targetUrl,
    client: entry.client,
    server: entry.server,
    ...(entry.configuredResource === undefined ? {} : { oauthResource: entry.configuredResource }),
    tokens: { ...tokens, resource: entry.resource },
  };
  const detail: ConnectorDetail = {
    issuer: entry.server.issuer,
    ...(create.clientId === undefined ? {} : { clientId: create.clientId }),
    server: verified.server,
    verifiedAt: now,
    signedInAt: now,
    ...(create.autoName ? { named: AUTO_NAMED } : {}),
  };
  const name = (create.autoName ? accountName(verified, secret) : null) ?? create.name;
  const row: ConnectorRow = { id: entry.connector, owner: caller.owner, name, url: create.url, auth: 'oauth', authGeneration: entry.generation, policy: null, secret: null, detail: detailText(detail), createdBy: caller.session.userId, createdAt: now, updatedAt: now };
  await deps.store.create({ ...row, secret: sealConnectorSecret(key, row, secret) });
  log.info({ owner: caller.owner, id: row.id, host: new URL(row.url).hostname }, 'org-connectors: connector added, its first sign-in completed');
  return viewOf(deps, caller.owner, row.id);
}

export async function completeSignIn(deps: ActionDeps, caller: Caller, body: unknown): Promise<ConnectorView> {
  const key = sealingKey(deps);
  const entry = takeHandoff(deps, isRecord(body) ? body.handoff : undefined, caller.session);
  if (entry.create !== undefined) return completeNew(deps, caller, key, entry, entry.create);
  const before = await deps.store.find(caller.owner, entry.connector);
  checkGeneration(before, entry.generation);
  checkSignInTarget(key, before, entry);
  const { tokens, verified } = await finishSignIn(deps, entry);
  const now = at(deps);
  await deps.store.edit(caller.owner, entry.connector, now, (row) => {
    checkGeneration(row, entry.generation);
    const { imported, ...secret } = checkSignInTarget(key, row, entry);
    const replaced = entry.storedClient !== undefined;
    const { clientId, ...kept } = detailOf(row.detail);
    const detail: ConnectorDetail = { ...kept, ...(clientId === undefined || replaced ? {} : { clientId }), issuer: entry.server.issuer, server: verified.server, verifiedAt: now, signedInAt: now };
    const owned = imported === undefined || replaced ? {} : { imported: { state: 'owned' as const, tokenEndpointAuthMethod: imported.tokenEndpointAuthMethod, ...(entry.server.scopes.length === 0 ? {} : { scope: entry.server.scopes.join(' ') }) } };
    const signed: OAuthSecret = { ...secret, client: entry.client, ...owned, tokens: { ...tokens, resource: entry.resource } };
    const renamed = isAutoNamed(kept) ? accountName(verified, signed) : null;
    return {
      change: { secret: sealConnectorSecret(key, row, signed), detail: detailText(detail), ...(renamed === null || renamed === row.name ? {} : { name: renamed }) },
    };
  });
  log.info({ owner: caller.owner, id: entry.connector }, 'org-connectors: sign-in completed');
  return viewOf(deps, caller.owner, entry.connector);
}
