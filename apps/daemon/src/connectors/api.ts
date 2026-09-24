import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { healthOf } from './health.js';
import type { RemoteTool } from './tools.js';
import { normalizePolicy, type ToolPolicy } from '../policy/policy.js';
import {
  apiFailure,
  apiSession,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
} from '@metro-labs/http/api-http';
import { parseId } from '@metro-labs/core/ids';
import {
  handleCallback,
  handleConnect,
  hostOf,
  startOAuth,
  type OAuthRouteDeps,
} from './oauth-routes.js';
import { ConnectorUnauthorized } from './verify.js';
import type {
  Connector,
  ConnectorCheck,
  ConnectorInput,
  DeletedConnector,
} from './store.js';

const PREFIX = '/api/connectors';

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export interface ConnectorApiDeps extends OAuthRouteDeps {
  listConnectors: () => Promise<Connector[]>;
  createConnector: (input: ConnectorInput) => Promise<Connector>;
  verifyConnector: (id: string) => Promise<ConnectorCheck>;
  connectorTools: (id: string) => Promise<RemoteTool[]>;
  disconnectConnector: (id: string) => Promise<Connector>;
  renameConnector: (id: string, name: string) => Promise<Connector>;
  deleteConnector: (id: string) => Promise<DeletedConnector>;
  setConnectorPolicy: (id: string, policy: ToolPolicy) => Promise<Connector>;
}

type Routable =
  | { kind: 'collection' }
  | { kind: 'callback' }
  | { kind: 'connector'; id: string }
  | { kind: 'verify'; id: string }
  | { kind: 'tools'; id: string }
  | { kind: 'connect'; id: string }
  | { kind: 'disconnect'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'policy'; id: string };

type Target = Routable | { kind: 'unknown' } | null;

function subTarget(id: string, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'connector', id };
  if (rest.length > 1) return { kind: 'unknown' };
  const head = rest[0];
  if (head === 'verify') return { kind: 'verify', id };
  if (head === 'tools') return { kind: 'tools', id };
  if (head === 'connect') return { kind: 'connect', id };
  if (head === 'disconnect') return { kind: 'disconnect', id };
  if (head === 'rename') return { kind: 'rename', id };
  if (head === 'policy') return { kind: 'policy', id };
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

function connectorPayload(row: Connector): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    auth: row.auth,
    header: row.header,
    clientId: row.client?.clientId ?? null,
    signIn: row.signIn,
    verified: row.verified,
    policy: row.policy,
    health: healthOf(row.id),
  };
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
): Promise<void> {
  const rows = await deps.listConnectors();
  sendJson(req, res, 200, {
    connectors: rows.map((row) => connectorPayload(row)),
  });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const offered = asText(bodyField(body, 'value')).trim() !== '';
  try {
    const created = await deps.createConnector({
      name: bodyField(body, 'name'),
      url: bodyField(body, 'url'),
      header: bodyField(body, 'header'),
      value: bodyField(body, 'value'),
      clientId: bodyField(body, 'clientId'),
      clientSecret: bodyField(body, 'clientSecret'),
    });
    log.info(
      { id: created.id, name: created.name, host: hostOf(created.url) },
      'connector-api: created connector',
    );
    sendJson(req, res, 201, connectorPayload(created));
  } catch (err) {
    if (offered || !(err instanceof ConnectorUnauthorized)) throw err;
    await startOAuth(req, res, deps, body, (row) =>
      connectorPayload(row),
    );
  }
}

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  id: string,
): Promise<void> {
  const check = await deps.verifyConnector(id);
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
  id: string,
): Promise<void> {
  const row = await deps.disconnectConnector(id);
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
  id: string,
): Promise<void> {
  const gone = await deps.deleteConnector(id);
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
  id: string,
): Promise<void> {
  if (req.method !== 'GET') {
    await handleDelete(req, res, deps, id);
    return;
  }
  const row = await deps.getConnector(id);
  sendJson(req, res, 200, connectorPayload(row));
}

async function handleRename(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  id: string,
): Promise<void> {
  const name = bodyField(await readJsonBody(req), 'name');
  if (typeof name !== 'string') {
    sendJson(req, res, 400, { error: 'name is required' });
    return;
  }
  const row = await deps.renameConnector(id, name);
  log.info({ id: row.id, name: row.name }, 'connector-api: renamed connector');
  sendJson(req, res, 200, connectorPayload(row));
}

async function handlePolicy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  id: string,
): Promise<void> {
  const policy = normalizePolicy(bodyField(await readJsonBody(req), 'policy'));
  const row = await deps.setConnectorPolicy(id, policy);
  log.info({ id: row.id, name: row.name, policy: row.policy }, 'connector-api: tool policy set');
  sendJson(req, res, 200, connectorPayload(row));
}

type ById = Exclude<Routable['kind'], 'collection' | 'callback'>;

const BY_ID: Record<ById, (req: IncomingMessage, res: ServerResponse, deps: ConnectorApiDeps, id: string) => Promise<void>> = {
  verify: handleVerify,
  tools: async (req, res, deps, id) => {
    sendJson(req, res, 200, { tools: await deps.connectorTools(id) });
  },
  connect: handleConnect,
  disconnect: handleDisconnect,
  rename: handleRename,
  policy: handlePolicy,
  connector: handleConnector,
};

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  tgt: Routable,
): Promise<void> {
  try {
    if (tgt.kind === 'callback') return;
    if (tgt.kind !== 'collection') await BY_ID[tgt.kind](req, res, deps, tgt.id);
    else if (req.method === 'GET') await handleList(req, res, deps);
    else await handleCreate(req, res, deps);
  } catch (err) {
    apiFailure(req, res, err, 'connector-api');
  }
}

const ALLOWED: Record<Routable['kind'], string[]> = {
  collection: ['GET', 'POST'],
  callback: ['GET'],
  connector: ['GET', 'DELETE'],
  verify: ['POST'],
  tools: ['GET'],
  connect: ['POST'],
  disconnect: ['POST'],
  rename: ['POST'],
  policy: ['PUT'],
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
  await route(req, res, deps, tgt);
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
    if (res.headersSent) return;
    apiFailure(req, res, err, 'connector-api');
  });
  return true;
}
