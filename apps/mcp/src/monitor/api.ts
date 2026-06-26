import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '../daemon/log.js';
import { subscribeEvents, type MetroEvent } from '../daemon/events.js';

export type MonitorCall = (
  train: string,
  action: string,
  args: Record<string, unknown>,
) => Promise<{ result: unknown }>;

const KEEPALIVE_MS = 25_000;
const CALL_BODY_MAX = 256 * 1024;
const METRO_VERSION = process.env.npm_package_version ?? '0.1.0-beta.15';

function monitorToken(): string {
  return process.env.METRO_MONITOR_TOKEN ?? '';
}

function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function sendJson(
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

function authorized(req: IncomingMessage, q: URLSearchParams): boolean {
  const token = monitorToken();
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && tokenEq(header.slice(7), token))
    return true;
  const qt = q.get('token');
  return Boolean(qt && tokenEq(qt, token));
}

function parseCallArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as { args?: unknown };
  const value =
    parsed && typeof parsed === 'object' && 'args' in parsed
      ? parsed.args
      : parsed;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('call body must be a JSON object');
  return value as Record<string, unknown>;
}

async function readCallArgs(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > CALL_BODY_MAX)
      throw new Error(`request body exceeds ${CALL_BODY_MAX} bytes`);
    chunks.push(buf);
  }
  return parseCallArgs(Buffer.concat(chunks).toString('utf8').trim());
}

function startTailStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...cors(req),
  });
  res.write(': metro monitor tail (live)\n\n');
  let id = 0;
  const stop = subscribeEvents((e: MetroEvent): void => {
    id += 1;
    res.write(`id: ${id}\nevent: live\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const keepalive = setInterval(
    () => res.write(': keepalive\n\n'),
    KEEPALIVE_MS,
  );
  keepalive.unref?.();
  const cleanup = (): void => {
    stop();
    clearInterval(keepalive);
    try {
      res.end();
    } catch {
      log.debug('monitor: tail cleanup end failed');
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  train: string,
  action: string,
  call: MonitorCall,
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = await readCallArgs(req);
  } catch (err) {
    sendJson(res, req, 400, { error: `bad JSON body: ${errMsg(err)}` });
    return;
  }
  try {
    const { result } = await call(train, action, args);
    sendJson(res, req, 200, { result });
  } catch (err) {
    sendJson(res, req, 502, { error: errMsg(err) });
  }
}

function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  call: MonitorCall,
): void {
  const callMatch = /^\/api\/call\/([^/]+)\/([^/]+)$/.exec(path);
  if (callMatch) {
    if (req.method !== 'POST') {
      sendJson(res, req, 405, { error: 'method not allowed' });
      return;
    }
    handleCall(req, res, callMatch[1] ?? '', callMatch[2] ?? '', call).catch(
      (err: unknown) => {
        log.warn({ err: errMsg(err) }, 'monitor: call handler error');
        if (!res.headersSent) sendJson(res, req, 500, { error: errMsg(err) });
      },
    );
    return;
  }
  if (path === '/api/tail') {
    if (req.method !== 'GET') {
      sendJson(res, req, 405, { error: 'method not allowed' });
      return;
    }
    startTailStream(req, res);
    return;
  }
  sendJson(res, req, 404, { error: 'not found' });
}

function preflight(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  qs: string,
): boolean {
  if (!monitorToken()) {
    sendJson(res, req, 404, { error: 'not found' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, req, 200, {
      ok: true,
      service: 'metro',
      version: METRO_VERSION,
      uptime_s: Math.round(process.uptime()),
    });
    return true;
  }
  if (!authorized(req, new URLSearchParams(qs))) {
    sendJson(res, req, 401, { error: 'unauthorized' });
    return true;
  }
  return false;
}

export function handleMonitorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  call: MonitorCall,
): boolean {
  const url = req.url ?? '';
  const [rawPath, qs = ''] = url.split('?', 2);
  const path = rawPath ?? '';
  if (!path.startsWith('/api/')) return false;
  if (preflight(req, res, path, qs)) return true;
  routeApi(req, res, path, call);
  return true;
}
