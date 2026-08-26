import { and, eq } from 'drizzle-orm';
import { oauthExpired, refreshOAuth } from '../daemon/connector-oauth.js';
import {
  parseConnectorUrl,
  type ConnectorAuth,
  type OAuthAuth,
} from '../daemon/connector-verify.js';
import { errMsg, log } from '../daemon/log.js';
import { readConfig, type ConnectorConfig } from './connector-config.js';
import { getDb } from './client.js';
import { collectionItems, connectors } from './schema.js';

export type RelayTarget =
  | { kind: 'ok'; url: string; headers: Record<string, string> }
  | { kind: 'missing' }
  | { kind: 'signin' };

type ConnectorRow = typeof connectors.$inferSelect;

export const bearerHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

export function staleUsable(auth: OAuthAuth, now = Date.now()): boolean {
  return auth.expiresAt === undefined || auth.expiresAt > now;
}

export function headerAuthHeaders(
  auth: ConnectorAuth,
): Record<string, string> | null {
  return auth.kind === 'header' ? { [auth.name]: auth.value } : null;
}

async function memberRow(
  collectionId: string,
  connectorId: string,
): Promise<ConnectorRow | undefined> {
  const rows = await getDb()
    .select({ connector: connectors })
    .from(collectionItems)
    .innerJoin(connectors, eq(collectionItems.connectorId, connectors.id))
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        eq(collectionItems.connectorId, connectorId),
      ),
    );
  return rows[0]?.connector;
}

const inflight = new Map<string, Promise<OAuthAuth>>();

function refreshOnce(
  row: ConnectorRow,
  config: ConnectorConfig,
  auth: OAuthAuth,
): Promise<OAuthAuth> {
  const running = inflight.get(row.id);
  if (running !== undefined) return running;
  const resource = parseConnectorUrl(row.url).toString();
  const job = refreshOAuth(auth, resource)
    .then(async (fresh) => {
      await getDb()
        .update(connectors)
        .set({ config: { ...config, auth: fresh } })
        .where(eq(connectors.id, row.id));
      return fresh;
    })
    .finally(() => {
      inflight.delete(row.id);
    });
  inflight.set(row.id, job);
  return job;
}

async function oauthTarget(
  row: ConnectorRow,
  config: ConnectorConfig,
  auth: OAuthAuth,
  force: boolean,
): Promise<RelayTarget> {
  if (!force && !oauthExpired(auth))
    return { kind: 'ok', url: row.url, headers: bearerHeaders(auth.accessToken) };
  try {
    const fresh = await refreshOnce(row, config, auth);
    return { kind: 'ok', url: row.url, headers: bearerHeaders(fresh.accessToken) };
  } catch (err) {
    log.warn({ id: row.id, err: errMsg(err) }, 'relay: token refresh failed');
    if (!force && staleUsable(auth))
      return { kind: 'ok', url: row.url, headers: bearerHeaders(auth.accessToken) };
    return { kind: 'signin' };
  }
}

export function fixedTarget(
  url: string,
  auth: Exclude<ConnectorAuth, OAuthAuth>,
  force: boolean,
): RelayTarget {
  if (force) return { kind: 'signin' };
  return { kind: 'ok', url, headers: headerAuthHeaders(auth) ?? {} };
}

export async function relayTarget(
  collectionId: string,
  connectorId: string,
  force: boolean,
): Promise<RelayTarget> {
  const row = await memberRow(collectionId, connectorId);
  if (row === undefined) return { kind: 'missing' };
  parseConnectorUrl(row.url);
  const config = readConfig(row.config);
  const auth = config.auth;
  if (auth.kind === 'oauth') return oauthTarget(row, config, auth, force);
  return fixedTarget(row.url, auth, force);
}
