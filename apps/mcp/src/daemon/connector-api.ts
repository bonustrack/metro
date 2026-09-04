import type { ConnectorSummary } from '../db/connectors.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import {
  apiFailure,
  apiSession,
  projectParam,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
  type ApiSession,
} from './api-http.js';
import { parseId } from '../db/ids.js';
import type { RelayServerEntry } from './connector-json.js';
import {
  handleCallback,
  handleConnect,
  hostOf,
  startOAuth,
  type OAuthRouteDeps,
} from './connector-oauth-routes.js';
import { ConnectorUnauthorized } from './connector-verify.js';
import type {
  Connector,
  ConnectorCheck,
  ConnectorInput,
  DeletedConnector,
} from '../db/connectors.js';

const PREFIX = '/api/connectors';

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export interface ConnectorApiDeps extends OAuthRouteDeps {
  listConnectors: (subject: string, project: string) => Promise<Connector[]>;
  connectorSummariesByIds: (ids: string[]) => Promise<ConnectorSummary[]>;
  connectorNamesByIds: (ids: string[]) => Promise<RelayServerEntry[]>;
  createConnector: (
    subject: string,
    project: string,
    input: ConnectorInput,
  ) => Promise<Connector>;
  verifyConnector: (subject: string, id: string) => Promise<ConnectorCheck>;
  disconnectConnector: (subject: string, id: string) => Promise<Connector>;
  renameConnector: (
    subject: string,
    id: string,
    name: string,
  ) => Promise<Connector>;
  deleteConnector: (subject: string, id: string) => Promise<DeletedConnector>;
}

type Routable =
  | { kind: 'collection' }
  | { kind: 'callback' }
  | { kind: 'connector'; id: string }
  | { kind: 'verify'; id: string }
  | { kind: 'connect'; id: string }
  | { kind: 'disconnect'; id: string }
  | { kind: 'rename'; id: string };

type Target = Routable | { kind: 'unknown' } | null;

function subTarget(id: string, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'connector', id };
  if (rest.length > 1) return { kind: 'unknown' };
  const head = rest[0];
  if (head === 'verify') return { kind: 'verify', id };
  if (head === 'connect') return { kind: 'connect', id };
  if (head === 'disconnect') return { kind: 'disconnect', id };
  if (head === 'rename') return { kind: 'rename', id };
  return { kind: 'unknown' };
}

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'collection' };
  if (head === 'callback' && segments.length === 1) return { kind: 'callback' };
  const id = parseId(head);
  return id === null ? { kind: 'unknown' } : subTarget(id, segments.slice(1));
}

function connectorPayload(
  row: Connector,
  detail = false,
): Record<string, unknown> {
  const { catalog, ...summary } = row.verified;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    auth: row.auth,
    header: row.header,
    signIn: row.signIn,
    verified: detail ? { ...summary, catalog } : summary,
  };
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
): Promise<void> {
  const project = projectParam(req);
  if (project === null) {
    sendJson(req, res, 400, { error: 'a project is required' });
    return;
  }
  const rows = await deps.listConnectors(session.subject, project);
  sendJson(req, res, 200, {
    connectors: rows.map((row) => connectorPayload(row)),
  });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
): Promise<void> {
  const body = await readJsonBody(req);
  const project = projectParam(req);
  if (project === null) {
    sendJson(req, res, 400, { error: 'a project is required' });
    return;
  }
  const offered = asText(bodyField(body, 'value')).trim() !== '';
  try {
    const created = await deps.createConnector(session.subject, project, {
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
    await startOAuth(req, res, deps, session, project, body, (row) =>
      connectorPayload(row),
    );
  }
}

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const check = await deps.verifyConnector(session.subject, id);
  log.info(
    { id: check.id, name: check.name, ok: check.ok },
    'connector-api: re-verified connector',
  );
  sendJson(req, res, 200, check);
}

async function handleDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const row = await deps.disconnectConnector(session.subject, id);
  log.info(
    { id: row.id, name: row.name },
    'connector-api: signed the connector out',
  );
  sendJson(req, res, 200, connectorPayload(row));
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const gone = await deps.deleteConnector(session.subject, id);
  log.info(
    { id: gone.id, name: gone.name },
    'connector-api: deleted connector',
  );
  sendJson(req, res, 200, { id: gone.id, name: gone.name, deleted: true });
}

async function handleConnector(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  if (req.method !== 'GET') {
    await handleDelete(req, res, deps, session, id);
    return;
  }
  const row = await deps.getConnector(session.subject, id);
  sendJson(req, res, 200, connectorPayload(row, true));
}

async function handleRename(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const name = bodyField(await readJsonBody(req), 'name');
  if (typeof name !== 'string') {
    sendJson(req, res, 400, { error: 'name is required' });
    return;
  }
  const row = await deps.renameConnector(session.subject, id, name);
  log.info({ id: row.id, name: row.name }, 'connector-api: renamed connector');
  sendJson(req, res, 200, connectorPayload(row));
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
    else if (tgt.kind === 'connect')
      await handleConnect(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'disconnect')
      await handleDisconnect(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'rename')
      await handleRename(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'connector')
      await handleConnector(req, res, deps, session, tgt.id);
    else if (req.method === 'GET') await handleList(req, res, deps, session);
    else await handleCreate(req, res, deps, session);
  } catch (err) {
    apiFailure(req, res, err, 'connector-api');
  }
}

const ALLOWED: Record<Routable['kind'], string[]> = {
  collection: ['GET', 'POST'],
  callback: ['GET'],
  connector: ['GET', 'DELETE'],
  verify: ['POST'],
  connect: ['POST'],
  disconnect: ['POST'],
  rename: ['POST'],
};

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  tgt: Routable,
): Promise<void> {
  if (tgt.kind === 'callback') {
    handleCallback(req, res, deps);
    return;
  }
  const session = await apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  await route(req, res, deps, session, tgt);
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
