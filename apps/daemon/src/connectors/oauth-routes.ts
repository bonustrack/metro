import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { bodyField, readJsonBody, sendJson, stringOf } from '@metro-labs/http/api-http';
import {
  beginOAuth,
  completeOAuth,
  prepareOAuth,
  takePending,
  type PendingAuth,
} from './oauth.js';
import { connectorClient, connectorName } from '@metro-labs/http/connector-input';
import { parseConnectorUrl } from '@metro-labs/http/connector-url';
import type { OAuthAuth } from '@metro-labs/http/connector-mcp';
import type { Connector, PendingConnectorInput } from './store.js';
import { agentsDir } from '../agents/files.js';
import { withLocalMigrationOperation } from './migration-guard.js';
import { migrationRecord } from './migration-state.js';
import { ApiError } from '@metro-labs/http/api-error';

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface OAuthRouteDeps {
  migrationDir?: string;
  createPendingConnector: (input: PendingConnectorInput) => Promise<Connector>;
  reconnectConnector: (id: string, auth: OAuthAuth) => Promise<Connector>;
  getConnector: (id: string) => Promise<Connector>;
}

export async function startOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
  body: unknown,
  payload: (row: Connector) => Record<string, unknown>,
): Promise<void> {
  const name = connectorName(bodyField(body, 'name'));
  await withLocalMigrationOperation('', deps.migrationDir ?? agentsDir(), async (operation) => {
    const url = parseConnectorUrl(bodyField(body, 'url'));
    const returnTo = stringOf(bodyField(body, 'returnTo'));
    const clientId = bodyField(body, 'clientId');
    const clientSecret = bodyField(body, 'clientSecret');
    const prepared = await prepareOAuth({
      url,
      client: connectorClient(clientId, clientSecret),
      returnTo,
    }, operation.fetch);
    const row = await deps.createPendingConnector({
      name,
      url: bodyField(body, 'url'),
      clientId,
      clientSecret,
    });
    operation.check();
    const authorize = beginOAuth(prepared, {
      name: row.name,
      url,
      returnTo,
      connectorId: row.id,
      migrationId: migrationRecord(row.id, deps.migrationDir)?.id ?? null,
    });
    log.info(
      { id: row.id, host: url.hostname },
      'connector-api: stored unconnected, sending the user to sign in',
    );
    sendJson(req, res, 201, { ...payload(row), authorizeUrl: authorize });
  }, true);
}

export async function handleConnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
  id: string,
): Promise<void> {
  await withLocalMigrationOperation(id, deps.migrationDir ?? agentsDir(), async (operation) => {
    const row = await deps.getConnector(id);
    const url = parseConnectorUrl(row.url);
    const body = await readJsonBody(req);
    const returnTo = stringOf(bodyField(body, 'returnTo'));
    const prepared = await prepareOAuth({ url, client: row.client, returnTo }, operation.fetch);
    operation.check();
    const authorize = beginOAuth(prepared, {
      name: row.name,
      url,
      returnTo,
      connectorId: row.id,
      migrationId: migrationRecord(row.id, deps.migrationDir)?.id ?? null,
    });
    log.info(
      { id: row.id, host: url.hostname },
      'connector-api: sending the user back to sign in',
    );
    sendJson(req, res, 202, { status: 'oauth', authorizeUrl: authorize });
  }, true);
}

function landing(entry: PendingAuth, id?: string): string {
  const target = id ?? entry.connectorId;
  return target === undefined ? '#/connectors' : `#/connector/${target}`;
}

function backTo(entry: PendingAuth, error?: string, id?: string): string {
  const suffix =
    error === undefined
      ? ''
      : `?connector_error=${encodeURIComponent(error)}`;
  return `${entry.returnTo}${suffix}${landing(entry, id)}`;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
}

async function saveOAuth(
  deps: OAuthRouteDeps,
  entry: PendingAuth,
  auth: OAuthAuth,
): Promise<Connector> {
  return deps.reconnectConnector(entry.connectorId, auth);
}

function checkGeneration(entry: PendingAuth, dir: string | undefined): void {
  if ((entry.migrationId ?? null) !== (migrationRecord(entry.connectorId, dir)?.id ?? null)) throw new ApiError('This sign-in predates the connector migration. Start a fresh sign-in.', 409);
}

async function settleCallback(
  res: ServerResponse,
  deps: OAuthRouteDeps,
  entry: PendingAuth,
  code: string,
): Promise<void> {
  try {
    const saved = await withLocalMigrationOperation(entry.connectorId, deps.migrationDir ?? agentsDir(), async (operation) => {
      checkGeneration(entry, deps.migrationDir);
      const auth = await completeOAuth(entry, code, operation.fetch);
      operation.check();
      checkGeneration(entry, deps.migrationDir);
      return saveOAuth(deps, entry, auth);
    }, true);
    log.info(
      { id: saved.id, name: saved.name, host: hostOf(saved.url) },
      'connector-api: oauth sign-in completed',
    );
    redirect(res, backTo(entry, undefined, saved.id));
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'connector-api: oauth sign-in failed');
    redirect(res, backTo(entry, errMsg(err)));
  }
}

export function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
): void {
  const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  const entry = takePending(query.get('state') ?? '');
  if (entry === undefined) {
    sendJson(req, res, 400, { error: 'that sign-in has expired — start it again' });
    return;
  }
  const denied = query.get('error');
  const code = query.get('code') ?? '';
  if (denied !== null || code === '') {
    redirect(res, backTo(entry, denied ?? 'no authorization code came back'));
    return;
  }
  settleCallback(res, deps, entry, code).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'connector-api: oauth callback failed');
    if (!res.headersSent) redirect(res, backTo(entry, 'sign-in failed'));
  });
}
