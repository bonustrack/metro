import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { bodyField, readJsonBody, sendJson, type ApiSession } from '@metro-labs/http/api-http';
import {
  beginOAuth,
  completeOAuth,
  prepareOAuth,
  takePending,
  type PendingAuth,
} from './oauth.js';
import { connectorClient } from './config.js';
import { parseConnectorUrl } from './verify.js';
import type { OAuthAuth } from './verify.js';
import type { Connector, PendingConnectorInput } from './model.js';

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface OAuthRouteDeps {
  createPendingConnector: (
    subject: string,
    project: string,
    input: PendingConnectorInput,
  ) => Promise<Connector>;
  reconnectConnector: (
    subject: string,
    id: string,
    auth: OAuthAuth,
  ) => Promise<Connector>;
  getConnector: (subject: string, id: string) => Promise<Connector>;
}

export async function startOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
  session: ApiSession,
  project: string,
  body: unknown,
  payload: (row: Connector) => Record<string, unknown>,
): Promise<void> {
  const url = parseConnectorUrl(bodyField(body, 'url'));
  const returnTo = asText(bodyField(body, 'returnTo'));
  const clientId = bodyField(body, 'clientId');
  const clientSecret = bodyField(body, 'clientSecret');
  const prepared = await prepareOAuth({
    url,
    client: connectorClient(clientId, clientSecret),
    returnTo,
  });
  const row = await deps.createPendingConnector(session.subject, project, {
    name: bodyField(body, 'name'),
    url: bodyField(body, 'url'),
    clientId,
    clientSecret,
  });
  const authorize = beginOAuth(prepared, {
    subject: session.subject,
    name: row.name,
    url,
    returnTo,
    connectorId: row.id,
  });
  log.info(
    { id: row.id, host: url.hostname },
    'connector-api: stored unconnected, sending the user to sign in',
  );
  sendJson(req, res, 201, { ...payload(row), authorizeUrl: authorize });
}

export async function handleConnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const row = await deps.getConnector(session.subject, id);
  const url = parseConnectorUrl(row.url);
  const body = await readJsonBody(req);
  const returnTo = asText(bodyField(body, 'returnTo'));
  const prepared = await prepareOAuth({ url, client: row.client, returnTo });
  const authorize = beginOAuth(prepared, {
    subject: session.subject,
    name: row.name,
    url,
    returnTo,
    connectorId: row.id,
  });
  log.info(
    { id: row.id, host: url.hostname },
    'connector-api: sending the user back to sign in',
  );
  sendJson(req, res, 202, { status: 'oauth', authorizeUrl: authorize });
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
  return deps.reconnectConnector(entry.subject, entry.connectorId, auth);
}

async function settleCallback(
  res: ServerResponse,
  deps: OAuthRouteDeps,
  entry: PendingAuth,
  code: string,
): Promise<void> {
  try {
    const auth = await completeOAuth(entry, code);
    const saved = await saveOAuth(deps, entry, auth);
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
