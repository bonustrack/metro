import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { errMsg, log } from '@metro-labs/core/log';

const BODY_MAX = 4 * 1024;

export type Role = 'admin' | 'member';

export interface ApiSession {
  subject: string;
  role: Role;
}

export type BearerSessions = (req: IncomingMessage) => Promise<ApiSession | null>;

let bearerSessions: BearerSessions | null = null;

export function setBearerSessions(fn: BearerSessions | null): void {
  bearerSessions = fn;
}

export function requireAdmin(session: ApiSession): void {
  if (session.role !== 'admin') throw new ApiError('this needs the admin role in your organization', 403);
}

export function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export function sendJson(
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

export function apiSession(req: IncomingMessage): Promise<ApiSession | null> {
  return bearerSessions === null ? Promise.resolve(null) : bearerSessions(req);
}

export interface AgentIdentity {
  subject: string;
  agentId: string;
}

export async function readJsonBody(req: IncomingMessage, max = BODY_MAX): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > max) over = true;
    if (!over) chunks.push(buf);
    else if (total > 2 * max) break;
  }
  if (over) throw new ApiError('request body too large', 413);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError('body must be JSON', 400);
  }
}

export function apiFailure(
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
  label = 'agent-api',
): void {
  if (err instanceof ApiError) {
    sendJson(req, res, err.status, { error: err.message });
    return;
  }
  log.warn({ err: errMsg(err) }, `${label}: request failed`);
  if (!res.headersSent) sendJson(req, res, 500, { error: `${label} failed` });
}

export interface SessionRoute {
  methods: Readonly<Record<string, readonly string[]>>;
  admin: boolean | readonly string[];
  label: string;
}

const needsAdmin = (route: SessionRoute, method: string): boolean =>
  route.admin === true || (Array.isArray(route.admin) && route.admin.includes(method));

export function sessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: SessionRoute,
  handler: (session: ApiSession, path: string) => Promise<unknown>,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const methods = Object.hasOwn(route.methods, path) ? route.methods[path] : undefined;
  if (methods === undefined) return false;
  const method = req.method ?? '';
  if (method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (!methods.includes(method)) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      if (needsAdmin(route, method)) requireAdmin(session);
      sendJson(req, res, 200, await handler(session, path));
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, route.label);
    });
  return true;
}

export function bodyField(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
}
