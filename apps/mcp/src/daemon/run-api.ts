import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './log.js';
import {
  apiFailure,
  bodyField,
  cors,
  readJsonBody,
  runIdentity,
  sendJson,
} from './api-http.js';
import { RUN_CODE_RE, takeRunCode } from './run-pair.js';
import { sessionTtlFromEnv } from './google-oauth.js';
import { signRunToken } from './session.js';
import type { LoadedAgent } from '../db/materialize.js';
import type { RuntimeLease } from '../db/runtimes.js';

const CLAIM_PATH = '/api/run/claim';
const CONFIG_PATH = '/api/run/config';

const ALLOWED: Record<string, string> = {
  [CLAIM_PATH]: 'POST',
  [CONFIG_PATH]: 'GET',
};

export interface RunApiDeps {
  claimRuntime: (agentId: string, label: string) => Promise<RuntimeLease>;
  fenceRuntime: (runtimeId: string, agentId: string) => Promise<void>;
  touchRuntime: (runtimeId: string) => Promise<void>;
  loadAgent: (agentId: string) => Promise<LoadedAgent>;
}

function secretOrNull(): string | null {
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  return secret === '' ? null : secret;
}

function labelOf(body: unknown): string {
  const raw = bodyField(body, 'label');
  const label = typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
  return label === '' ? 'unnamed machine' : label;
}

async function handleClaim(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunApiDeps,
): Promise<void> {
  const secret = secretOrNull();
  if (secret === null) {
    sendJson(req, res, 503, { error: 'sign-in is not configured' });
    return;
  }
  const body = await readJsonBody(req);
  const code = bodyField(body, 'code');
  const taken =
    typeof code === 'string' && RUN_CODE_RE.test(code)
      ? takeRunCode(code)
      : undefined;
  if (taken === undefined) {
    sendJson(req, res, 400, {
      error: 'that code has expired or was already used',
    });
    return;
  }
  const lease = await deps.claimRuntime(taken.agentId, labelOf(body));
  const token = signRunToken(
    { email: taken.email, agentId: lease.agentId, runtimeId: lease.runtimeId },
    secret,
    { ttlSec: sessionTtlFromEnv() },
  );
  log.info(
    { agent: lease.agentId, runtime: lease.runtimeId, label: lease.label },
    'run: agent claimed by a local runtime',
  );
  sendJson(req, res, 200, {
    token,
    agent: lease.agentId,
    label: lease.label,
  });
}

async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunApiDeps,
): Promise<void> {
  const who = runIdentity(req);
  if (who === null) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  await deps.fenceRuntime(who.runtimeId, who.agentId);
  await deps.touchRuntime(who.runtimeId);
  sendJson(req, res, 200, { agent: await deps.loadAgent(who.agentId) });
}

export function handleRunApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunApiDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const method = ALLOWED[path];
  if (method === undefined) {
    if (!path.startsWith('/api/run/') && path !== '/api/run') return false;
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
      : handleConfig(req, res, deps);
  work.catch((err: unknown) => {
    apiFailure(req, res, err, 'run-api');
  });
  return true;
}
