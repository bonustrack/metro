import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import {
  bodyField,
  cliIdentity,
  cors,
  readJsonBody,
  sendJson,
} from './api-http.js';
import { CLI_CODE_RE, takeCliCode } from './cli-pair.js';
import { mcpServersJson } from './connector-json.js';
import { sessionTtlFromEnv } from './google-oauth.js';
import { signCliToken } from './session.js';
import type { ConnectorApiDeps } from './connector-api.js';

const CLAIM_PATH = '/api/cli/claim';
const MCP_PATH = '/api/cli/mcp';
const SESSION_PATH = '/api/cli/session';

const ALLOWED: Record<string, string> = {
  [CLAIM_PATH]: 'POST',
  [MCP_PATH]: 'GET',
  [SESSION_PATH]: 'GET',
};

function secretOrNull(): string | null {
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  return secret === '' ? null : secret;
}

async function handleClaim(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
): Promise<void> {
  const secret = secretOrNull();
  if (secret === null) {
    sendJson(req, res, 503, { error: 'sign-in is not configured' });
    return;
  }
  const code = bodyField(await readJsonBody(req), 'code');
  const taken =
    typeof code === 'string' && CLI_CODE_RE.test(code)
      ? takeCliCode(code)
      : undefined;
  if (taken === undefined) {
    sendJson(req, res, 400, {
      error: 'that code has expired or was already used',
    });
    return;
  }
  const collection = await deps.getCollection(taken.email, taken.collectionId);
  const token = signCliToken(
    { email: taken.email, collectionId: collection.id },
    secret,
    { ttlSec: sessionTtlFromEnv() },
  );
  log.info({ email: taken.email, collection: collection.id }, 'cli: code claimed');
  sendJson(req, res, 200, { token, email: taken.email, collection: collection.name });
}

async function handleRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  path: string,
): Promise<void> {
  const who = cliIdentity(req);
  if (who === null) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  const collection = await deps.getCollection(who.email, who.collectionId);
  if (path === SESSION_PATH) {
    sendJson(req, res, 200, { email: who.email, collection: collection.name });
    return;
  }
  const rows = await deps.freshConnectorsByIds(collection.connectorIds);
  sendJson(req, res, 200, { json: mcpServersJson(rows), collection: collection.name });
}

export function handleCliPairRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const method = ALLOWED[path];
  if (method === undefined) {
    if (!path.startsWith('/api/cli/') && path !== '/api/cli') return false;
    sendJson(req, res, 404, { error: 'no such route' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== method) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const work =
    path === CLAIM_PATH
      ? handleClaim(req, res, deps)
      : handleRead(req, res, deps, path);
  work.catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'cli: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'cli api failed' });
  });
  return true;
}
