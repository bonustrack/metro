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
import { AGENT_CODE_RE, takeAgentCode } from './agent-pair.js';
import { SESSION_TTL_SEC } from './session-config.js';
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
  blockedStations: (agentId: string) => Promise<string[]>;
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
  const raw = bodyField(body, 'code');
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!AGENT_CODE_RE.test(code)) {
    sendJson(req, res, 400, {
      error:
        'that does not look like an agent code — metro start wants the ma_… code from the agent page',
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
  const blocked = await deps.blockedStations(taken.agentId);
  if (blocked.length > 0) {
    sendJson(req, res, 409, {
      error:
        `this agent holds ${blocked.join(', ')}, which only runs on metro because a webhook url has to be publicly reachable. Detach it, or move it to a second agent that stays on metro, then start this one.`,
    });
    return;
  }
  const lease = await deps.claimRuntime(taken.agentId, labelOf(body));
  const token = signRunToken(
    { subject: taken.subject, agentId: lease.agentId, runtimeId: lease.runtimeId },
    secret,
    { ttlSec: SESSION_TTL_SEC },
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
