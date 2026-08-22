import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';
import { verifyCliToken, verifySession, type CliClaims } from './session.js';
import { extractToken } from '../mcp/request-identity.js';

const BODY_MAX = 4 * 1024;
const DRAIN_MAX = 2 * BODY_MAX;

export interface ApiSession {
  email: string;
}

export function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
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

export function apiSession(req: IncomingMessage): ApiSession | null {
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (secret === '') return null;
  const token = extractToken(req) ?? '';
  if (token === '') return null;
  try {
    const { email } = verifySession(token, secret);
    return { email: email.toLowerCase() };
  } catch {
    return null;
  }
}

export function cliIdentity(req: IncomingMessage): CliClaims | null {
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (secret === '') return null;
  const token = extractToken(req) ?? '';
  if (token === '') return null;
  try {
    const { email, collectionId } = verifyCliToken(token, secret);
    return { email: email.toLowerCase(), collectionId };
  } catch {
    return null;
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > BODY_MAX) over = true;
    if (!over) chunks.push(buf);
    else if (total > DRAIN_MAX) break;
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
