import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';
import { verifySession } from './session.js';
import { agentsForEmail, parseEmailAgentMap } from './google-auth.js';

const BODY_MAX = 4 * 1024;

export interface ApiSession {
  email: string;
  granted: string[];
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

function bearerOrQueryToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const t = header.slice(7).trim();
    if (t !== '') return t;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') ?? '';
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

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = BODY_MAX,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new ApiError('request body too large', 413);
    chunks.push(buf);
  }
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
