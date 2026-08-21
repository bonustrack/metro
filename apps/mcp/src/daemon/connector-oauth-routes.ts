import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { bodyField, readJsonBody, sendJson, type ApiSession } from './api-http.js';
import {
  beginOAuth,
  completeOAuth,
  takePending,
  type PendingAuth,
} from './connector-oauth.js';
import { parseConnectorUrl } from './connector-verify.js';
import type { OAuthAuth } from './connector-verify.js';
import type { Connector, OAuthConnectorInput } from '../db/connectors.js';

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
  createOAuthConnector: (
    email: string,
    input: OAuthConnectorInput,
  ) => Promise<Connector>;
  reconnectConnector: (
    email: string,
    id: string,
    auth: OAuthAuth,
  ) => Promise<Connector>;
  getConnector: (email: string, id: string) => Promise<Connector>;
}

export async function startOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  session: ApiSession,
  body: unknown,
): Promise<void> {
  const url = parseConnectorUrl(bodyField(body, 'url'));
  const authorize = await beginOAuth({
    email: session.email,
    name: asText(bodyField(body, 'name')),
    url,
    returnTo: asText(bodyField(body, 'returnTo')),
  });
  log.info(
    { host: url.hostname },
    'connector-api: server wants oauth, sending the user to sign in',
  );
  sendJson(req, res, 202, { status: 'oauth', authorizeUrl: authorize });
}

export async function handleConnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const row = await deps.getConnector(session.email, id);
  const url = parseConnectorUrl(row.url);
  const body = await readJsonBody(req);
  const authorize = await beginOAuth({
    email: session.email,
    name: row.name,
    url,
    returnTo: asText(bodyField(body, 'returnTo')),
    connectorId: row.id,
  });
  log.info(
    { id: row.id, host: url.hostname },
    'connector-api: sending the user back to sign in',
  );
  sendJson(req, res, 202, { status: 'oauth', authorizeUrl: authorize });
}

function landing(entry: PendingAuth): string {
  return entry.connectorId === undefined
    ? '#/connectors'
    : `#/connector/${entry.connectorId}`;
}

function backTo(entry: PendingAuth, error?: string): string {
  const suffix =
    error === undefined
      ? ''
      : `?connector_error=${encodeURIComponent(error)}`;
  return `${entry.returnTo}${suffix}${landing(entry)}`;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
}

async function saveOAuth(
  deps: OAuthRouteDeps,
  entry: PendingAuth,
  auth: OAuthAuth,
): Promise<Connector> {
  if (entry.connectorId === undefined)
    return deps.createOAuthConnector(entry.email, {
      name: entry.name,
      url: entry.url,
      auth,
    });
  return deps.reconnectConnector(entry.email, entry.connectorId, auth);
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
    redirect(res, backTo(entry));
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
