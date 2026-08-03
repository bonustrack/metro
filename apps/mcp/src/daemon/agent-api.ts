import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { verifySession } from './session.js';
import { publicBaseUrl } from './attach-serve.js';
import { agentsForEmail, parseEmailAgentMap } from './google-auth.js';
import {
  AgentAdminError,
  parseAgentId,
  type AgentSummary,
  type CreatedAgent,
  type DeletedAgent,
} from '../db/agent-admin.js';

const PREFIX = '/api/agents';
const BODY_MAX = 4 * 1024;
const DEFAULT_PUBLIC_BASE = 'https://mcp.metro.box';

export interface AgentApiDeps {
  listAgents: (email: string, granted: string[]) => Promise<AgentSummary[]>;
  createAgent: (email: string, name: string) => Promise<CreatedAgent>;
  deleteAgent: (
    email: string,
    granted: string[],
    id: number,
  ) => Promise<DeletedAgent>;
  gatherAccounts: (allowed: Set<number>) => Promise<Record<string, unknown[]>>;
  capabilities: () => Record<string, string[]>;
}

type Target =
  | { kind: 'collection' }
  | { kind: 'agent'; id: number }
  | { kind: 'unknown' }
  | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const id = parseAgentId(path.slice(PREFIX.length + 1));
  return id === null ? { kind: 'unknown' } : { kind: 'agent', id };
}

export function mcpEndpoint(): string {
  return `${publicBaseUrl() ?? DEFAULT_PUBLIC_BASE}/mcp`;
}

export function mcpAddCommand(name: string, key: string): string {
  const url = `${mcpEndpoint()}?token=${key}`;
  return `claude mcp add --transport http --scope user ${name} "${url}"`;
}

function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...cors(req),
  });
  res.end(JSON.stringify(body));
}

function bearerOrQueryToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const t = header.slice(7).trim();
    if (t !== '') return t;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') ?? '';
}

export interface ApiSession {
  email: string;
  granted: string[];
}

function grantedFor(email: string): string[] {
  try {
    const map = parseEmailAgentMap(process.env.GOOGLE_EMAIL_AGENTS);
    return agentsForEmail(map, email) ?? [];
  } catch (e) {
    log.warn({ err: errMsg(e) }, 'agent-api: bad GOOGLE_EMAIL_AGENTS');
    return [];
  }
}

export function apiSession(req: IncomingMessage): ApiSession | null {
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (secret === '') return null;
  const token = bearerOrQueryToken(req);
  if (token === '') return null;
  try {
    const { email } = verifySession(token, secret);
    return { email: email.toLowerCase(), granted: grantedFor(email) };
  } catch {
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > BODY_MAX) throw new AgentAdminError('request body too large', 413);
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AgentAdminError('body must be JSON', 400);
  }
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
): Promise<void> {
  const list = await deps.listAgents(session.email, session.granted);
  const accounts = await deps.gatherAccounts(new Set(list.map((a) => a.id)));
  sendJson(req, res, 200, {
    email: session.email,
    endpoint: mcpEndpoint(),
    agents: list,
    accounts,
    capabilities: deps.capabilities(),
  });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = (body as { name?: unknown }).name;
  const created = await deps.createAgent(session.email, name as string);
  log.info(
    { agent: created.name, id: created.id, owner: session.email },
    'agent-api: created agent',
  );
  sendJson(req, res, 201, {
    id: created.id,
    name: created.name,
    key: created.key,
    endpoint: `${mcpEndpoint()}?token=${created.key}`,
    command: mcpAddCommand(created.name, created.key),
  });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  session: ApiSession,
  id: number,
): Promise<void> {
  const gone = await deps.deleteAgent(session.email, session.granted, id);
  log.info(
    { agent: gone.name, id: gone.id, owner: session.email },
    'agent-api: deleted agent',
  );
  sendJson(req, res, 200, { id: gone.id, name: gone.name, deleted: true });
}

function failure(
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
): void {
  if (err instanceof AgentAdminError) {
    sendJson(req, res, err.status, { error: err.message });
    return;
  }
  log.warn({ err: errMsg(err) }, 'agent-api: request failed');
  sendJson(req, res, 500, { error: 'agent api failed' });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
  id: number | null,
): Promise<void> {
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    if (id !== null) await handleDelete(req, res, deps, session, id);
    else if (req.method === 'GET') await handleList(req, res, deps, session);
    else await handleCreate(req, res, deps, session);
  } catch (err) {
    failure(req, res, err);
  }
}

const ALLOWED: Record<string, string[]> = {
  collection: ['GET', 'POST'],
  agent: ['DELETE'],
};

export function handleAgentApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps,
): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such agent' });
    return true;
  }
  if (!(ALLOWED[tgt.kind] ?? []).includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, tgt.kind === 'agent' ? tgt.id : null).catch(
    (err: unknown) => {
      log.warn({ err: errMsg(err) }, 'agent-api: unhandled error');
      if (!res.headersSent)
        sendJson(req, res, 500, { error: 'agent api failed' });
    },
  );
  return true;
}
