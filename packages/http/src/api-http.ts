import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { errMsg, log } from '@metro-labs/core/log';
import { signedIdentity } from './signed-identity.js';
import { identitySubject } from './identity-registry.js';

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

export async function apiSession(req: IncomingMessage): Promise<ApiSession | null> {
  const address = await signedIdentity(req);
  if (address !== null) {
    const subject = identitySubject(address);
    return subject === undefined ? null : { subject, role: 'admin' };
  }
  return bearerSessions === null ? null : bearerSessions(req);
}

export interface AgentIdentity {
  subject: string;
  agentId: string;
}

export function projectParam(req: IncomingMessage): string | null {
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get(
    'project',
  );
  return raw === null || raw === '' ? null : raw;
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

export function bodyField(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
}
