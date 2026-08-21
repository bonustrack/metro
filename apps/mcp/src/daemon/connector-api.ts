import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import {
  apiFailure,
  apiSession,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
  type ApiSession,
} from './api-http.js';
import { mcpServersJson } from './connector-json.js';

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';
import {
  beginOAuth,
  completeOAuth,
  takePending,
  type PendingAuth,
} from './connector-oauth.js';
import { ConnectorUnauthorized, parseConnectorUrl } from './connector-verify.js';
import type {
  Connector,
  ConnectorCheck,
  ConnectorInput,
  DeletedConnector,
  OAuthConnectorInput,
} from '../db/connectors.js';

const PREFIX = '/api/connectors';
const CONNECTOR_ID_RE = /^[1-9][0-9]{0,9}$/;

export interface ConnectorApiDeps {
  listConnectors: (email: string) => Promise<Connector[]>;
  createOAuthConnector: (
    email: string,
    input: OAuthConnectorInput,
  ) => Promise<Connector>;
  createConnector: (
    email: string,
    input: ConnectorInput,
  ) => Promise<Connector>;
  verifyConnector: (email: string, id: number) => Promise<ConnectorCheck>;
  deleteConnector: (email: string, id: number) => Promise<DeletedConnector>;
}

type Routable =
  | { kind: 'collection' }
  | { kind: 'callback' }
  | { kind: 'connector'; id: number }
  | { kind: 'verify'; id: number };

type Target = Routable | { kind: 'unknown' } | null;

function parseConnectorId(raw: string): number | null {
  return CONNECTOR_ID_RE.test(raw) ? Number(raw) : null;
}

function subTarget(id: number, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'connector', id };
  if (rest.length === 1 && rest[0] === 'verify') return { kind: 'verify', id };
  return { kind: 'unknown' };
}

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'collection' };
  if (head === 'callback' && segments.length === 1) return { kind: 'callback' };
  const id = parseConnectorId(head);
  return id === null ? { kind: 'unknown' } : subTarget(id, segments.slice(1));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function connectorPayload(row: Connector): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    auth: row.auth,
    header: row.header,
    secret: row.secret,
    json: mcpServersJson([row]),
    verified: row.verified,
  };
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
): Promise<void> {
  const rows = await deps.listConnectors(session.email);
  sendJson(req, res, 200, {
    connectors: rows.map(connectorPayload),
    json: mcpServersJson(rows),
  });
}

async function startOAuth(
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

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
): Promise<void> {
  const body = await readJsonBody(req);
  const offered = asText(bodyField(body, 'value')).trim() !== '';
  try {
    const created = await deps.createConnector(session.email, {
      name: bodyField(body, 'name'),
      url: bodyField(body, 'url'),
      header: bodyField(body, 'header'),
      value: bodyField(body, 'value'),
    });
    log.info(
      { id: created.id, name: created.name, host: hostOf(created.url) },
      'connector-api: created connector',
    );
    sendJson(req, res, 201, connectorPayload(created));
  } catch (err) {
    if (offered || !(err instanceof ConnectorUnauthorized)) throw err;
    await startOAuth(req, res, session, body);
  }
}

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: number,
): Promise<void> {
  const check = await deps.verifyConnector(session.email, id);
  log.info(
    { id: check.id, name: check.name, ok: check.ok },
    'connector-api: re-verified connector',
  );
  sendJson(req, res, 200, check);
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: number,
): Promise<void> {
  const gone = await deps.deleteConnector(session.email, id);
  log.info(
    { id: gone.id, name: gone.name },
    'connector-api: deleted connector',
  );
  sendJson(req, res, 200, { id: gone.id, name: gone.name, deleted: true });
}

function backTo(entry: PendingAuth, error?: string): string {
  const suffix =
    error === undefined
      ? ''
      : `?connector_error=${encodeURIComponent(error)}`;
  return `${entry.returnTo}${suffix}#/connectors`;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
}

async function settleCallback(
  res: ServerResponse,
  deps: ConnectorApiDeps,
  entry: PendingAuth,
  code: string,
): Promise<void> {
  try {
    const auth = await completeOAuth(entry, code);
    const created = await deps.createOAuthConnector(entry.email, {
      name: entry.name,
      url: entry.url,
      auth,
    });
    log.info(
      { id: created.id, name: created.name, host: hostOf(created.url) },
      'connector-api: oauth sign-in completed',
    );
    redirect(res, backTo(entry));
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'connector-api: oauth sign-in failed');
    redirect(res, backTo(entry, errMsg(err)));
  }
}

function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
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

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  tgt: Routable,
): Promise<void> {
  try {
    if (tgt.kind === 'callback') return;
    if (tgt.kind === 'verify')
      await handleVerify(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'connector')
      await handleDelete(req, res, deps, session, tgt.id);
    else if (req.method === 'GET') await handleList(req, res, deps, session);
    else await handleCreate(req, res, deps, session);
  } catch (err) {
    apiFailure(req, res, err, 'connector-api');
  }
}

const ALLOWED: Record<Routable['kind'], string[]> = {
  collection: ['GET', 'POST'],
  callback: ['GET'],
  connector: ['DELETE'],
  verify: ['POST'],
};

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  tgt: Routable,
): Promise<void> {
  if (tgt.kind === 'callback') {
    handleCallback(req, res, deps);
    return Promise.resolve();
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return Promise.resolve();
  }
  return route(req, res, deps, session, tgt);
}

export function handleConnectorApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such connector' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  dispatch(req, res, deps, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'connector-api: unhandled error');
    if (!res.headersSent)
      sendJson(req, res, 500, { error: 'connector api failed' });
  });
  return true;
}
