import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CALL_BODY_MAX = 256 * 1024;

const DEFAULT_HOSTS = 'monitor.metro.box,localhost,127.0.0.1';

export const METRO_VERSION =
  process.env.npm_package_version ?? '0.1.0-beta.15';

export function monitorHosts(): Set<string> {
  return new Set(
    (process.env.METRO_MONITOR_HOSTS ?? DEFAULT_HOSTS)
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function monitorToken(): string {
  return process.env.METRO_MONITOR_TOKEN ?? '';
}

export function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export function sendJson(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...cors(req) });
  res.end(JSON.stringify(body));
}

function tokenEq(given: string, want: string): boolean {
  const g = Buffer.from(given);
  const w = Buffer.from(want);
  return g.length === w.length && timingSafeEqual(g, w);
}

export function authorized(
  req: IncomingMessage,
  q: URLSearchParams,
): { status: number; msg: string } | null {
  const token = monitorToken();
  const header = ([] as string[]).concat(req.headers.authorization ?? [])[0];
  if (header?.startsWith('Bearer ') && tokenEq(header.slice(7), token))
    return null;
  const qt = q.get('token');
  if (qt && tokenEq(qt, token)) return null;
  return { status: 401, msg: 'unauthorized' };
}

export function hostAllowed(req: IncomingMessage): boolean {
  const host =
    (req.headers[':authority' as keyof typeof req.headers] as
      | string
      | undefined) ?? req.headers.host;
  return !host || monitorHosts().has((host.split(':')[0] ?? '').toLowerCase());
}

export async function readCallBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > CALL_BODY_MAX)
      throw new Error(`request body exceeds ${CALL_BODY_MAX} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function parseCallArgs(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as { args?: unknown };
  const value =
    parsed && typeof parsed === 'object' && 'args' in parsed
      ? parsed.args
      : parsed;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('call body must be a JSON object');
  return value as Record<string, unknown>;
}

export function healthSnapshot(): Record<string, unknown> {
  return {
    ok: true,
    service: 'metro',
    version: METRO_VERSION,
    uptime_s: Math.round(process.uptime()),
  };
}
