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
import { parseId } from '../db/ids.js';
import { mintCliCode } from './cli-pair.js';
import type { ConnectorApiDeps } from './connector-api.js';

const PREFIX = '/api/collections';

type Routable =
  | { kind: 'index' }
  | { kind: 'collection'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'code'; id: string }
  | { kind: 'items'; id: string }
  | { kind: 'item'; id: string; connectorId: string };

type Target = Routable | { kind: 'unknown' } | null;

const ALLOWED: Record<Routable['kind'], string[]> = {
  index: ['GET', 'POST'],
  collection: ['GET', 'DELETE'],
  rename: ['POST'],
  code: ['POST'],
  items: ['POST'],
  item: ['DELETE'],
};

function itemTarget(id: string, rest: string[]): Target {
  if (rest.length === 1) return { kind: 'items', id };
  if (rest.length > 2) return { kind: 'unknown' };
  const connectorId = parseId(rest[1] ?? '');
  return connectorId === null
    ? { kind: 'unknown' }
    : { kind: 'item', id, connectorId };
}

function subTarget(id: string, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'collection', id };
  const head = rest[0];
  if (head === 'items') return itemTarget(id, rest);
  if (rest.length > 1) return { kind: 'unknown' };
  if (head === 'rename') return { kind: 'rename', id };
  if (head === 'code') return { kind: 'code', id };
  return { kind: 'unknown' };
}

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'index' };
  const id = parseId(head);
  return id === null ? { kind: 'unknown' } : subTarget(id, segments.slice(1));
}

async function nameFrom(req: IncomingMessage): Promise<string | null> {
  const name = bodyField(await readJsonBody(req), 'name');
  return typeof name === 'string' ? name : null;
}

async function handleIndex(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(req, res, 200, { collections: await deps.listCollections(session.email) });
    return;
  }
  const name = await nameFrom(req);
  if (name === null) {
    sendJson(req, res, 400, { error: 'name is required' });
    return;
  }
  const list = await deps.createCollection(session.email, name);
  log.info({ id: list.id, name: list.name }, 'collection-api: created collection');
  sendJson(req, res, 201, list);
}

async function handleRename(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const name = await nameFrom(req);
  if (name === null) {
    sendJson(req, res, 400, { error: 'name is required' });
    return;
  }
  sendJson(req, res, 200, await deps.renameCollection(session.email, id, name));
}

async function handleItems(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const connectorId = bodyField(await readJsonBody(req), 'connectorId');
  if (typeof connectorId !== 'string' || parseId(connectorId) === null) {
    sendJson(req, res, 400, { error: 'connectorId is required' });
    return;
  }
  sendJson(req, res, 200, await deps.addToCollection(session.email, id, connectorId));
}

async function handleCode(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  const collection = await deps.getCollection(session.email, id);
  const minted = mintCliCode({ email: session.email, collectionId: collection.id });
  log.info({ id: collection.id, email: session.email }, 'collection-api: minted cli code');
  sendJson(req, res, 200, { ...minted, collection: collection.name });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  session: ApiSession,
  tgt: Routable,
): Promise<void> {
  try {
    if (tgt.kind === 'index')
      await handleIndex(req, res, deps, session);
    else if (tgt.kind === 'rename')
      await handleRename(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'code')
      await handleCode(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'items')
      await handleItems(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'item')
      sendJson(
        req,
        res,
        200,
        await deps.removeFromCollection(session.email, tgt.id, tgt.connectorId),
      );
    else if (req.method === 'DELETE')
      sendJson(req, res, 200, await deps.deleteCollection(session.email, tgt.id));
    else sendJson(req, res, 200, await deps.getCollection(session.email, tgt.id));
  } catch (err) {
    apiFailure(req, res, err, 'collection-api');
  }
}

export function handleCollectionApiRequest(
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
    sendJson(req, res, 404, { error: 'no such collection' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  route(req, res, deps, session, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'list-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'list api failed' });
  });
  return true;
}
