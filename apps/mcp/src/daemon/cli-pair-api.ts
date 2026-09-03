import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './log.js';
import {
  agentIdentity,
  apiFailure,
  assertLease,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
} from './api-http.js';
import { extractToken } from '../mcp/request-identity.js';
import { publicBaseOrDefault } from './attach-serve.js';
import { AGENT_CODE_RE, takeAgentCode } from './agent-pair.js';
import { relayServersJson } from './connector-json.js';
import { sessionTtlFromEnv } from './google-oauth.js';
import { signAgentToken } from './session.js';
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
  const raw = bodyField(await readJsonBody(req), 'code');
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!AGENT_CODE_RE.test(code)) {
    sendJson(req, res, 400, {
      error:
        'that does not look like an agent code — metro login wants the ma_… code from the agent page',
    });
    return;
  }
  const taken = takeAgentCode(code);
  if (taken === undefined) {
    sendJson(req, res, 400, {
      error: 'that code has expired or was already used',
    });
    return;
  }
  const agent = await deps.agentConnectors(taken.email, taken.agentId);
  const token = signAgentToken(
    { email: taken.email, agentId: agent.id },
    secret,
    { ttlSec: sessionTtlFromEnv() },
  );
  log.info({ email: taken.email, agent: agent.id }, 'cli: code claimed');
  sendJson(req, res, 200, { token, email: taken.email, agent: agent.name });
}

async function handleRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorApiDeps,
  path: string,
): Promise<void> {
  const who = agentIdentity(req);
  if (who === null) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  await assertLease(who, deps.fenceRuntime);
  const agent = await deps.agentConnectors(who.email, who.agentId);
  if (path === SESSION_PATH) {
    sendJson(req, res, 200, { email: who.email, agent: agent.name });
    return;
  }
  const entries = await deps.connectorNamesByIds(agent.connectorIds);
  const json = relayServersJson(
    entries,
    publicBaseOrDefault(),
    extractToken(req) ?? '',
  );
  sendJson(req, res, 200, { json, agent: agent.name });
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
    apiFailure(req, res, err, 'cli');
  });
  return true;
}
