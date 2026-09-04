import type { IncomingMessage, ServerResponse } from 'node:http';
import { stationByName } from '../stations/registry.js';
import { errMsg, log } from '../daemon/log.js';
import { subscribeEvents, type MetroEvent } from '../daemon/events.js';
import { callTargetDenied, eventInScope } from '../db/agent-scope.js';
import { hasAnyKey } from '../db/key-map.js';
import {
  allowedAgents,
  authenticate,
} from '../mcp/request-identity.js';
import { METRO_VERSION } from '../daemon/version.js';

export type MonitorCall = (
  train: string,
  action: string,
  args: Record<string, unknown>,
) => Promise<{ result: unknown }>;

const KEEPALIVE_MS = 25_000;
const CALL_BODY_MAX = 256 * 1024;

const monitorEnabled = (): boolean => hasAnyKey();

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

function startTailStream(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: Set<string>,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...cors(req),
  });
  const timers: { keepalive?: ReturnType<typeof setInterval> } = {};
  const subs: { stop?: () => void } = {};
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    subs.stop?.();
    if (timers.keepalive) clearInterval(timers.keepalive);
    try {
      res.end();
    } catch {
      log.debug('monitor: tail cleanup end failed');
    }
  };
  const write = (chunk: string): void => {
    if (done) return;
    if (res.destroyed || res.writableEnded) {
      cleanup();
      return;
    }
    try {
      res.write(chunk);
    } catch (err) {
      log.debug({ err: errMsg(err) }, 'monitor: tail write failed');
      cleanup();
    }
  };
  write(': metro monitor tail (live)\n\n');
  let id = 0;
  subs.stop = subscribeEvents((e: MetroEvent): void => {
    if (!eventInScope(allowed, e.line)) return;
    id += 1;
    write(`id: ${id}\nevent: live\ndata: ${JSON.stringify(e)}\n\n`);
  });
  timers.keepalive = setInterval(() => {
    write(': keepalive\n\n');
  }, KEEPALIVE_MS);
  timers.keepalive.unref?.();
  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  train: string,
  action: string,
  call: MonitorCall,
  allowed: Set<string>,
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = await readCallArgs(req);
  } catch (err) {
    sendJson(res, req, 400, { error: `bad JSON body: ${errMsg(err)}` });
    return;
  }
  if (callTargetDenied(allowed, train, args)) {
    sendJson(res, req, 403, {
      error: 'metro: this account is outside your authorized scope',
    });
    return;
  }
  if (stationByName(train)?.hasTrain === false) {
    sendJson(res, req, 400, {
      error: `metro: station '${train}' runs in-core and takes no calls`,
    });
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
  allowed: Set<string>,
): void {
  const callMatch = /^\/api\/call\/([^/]+)\/([^/]+)$/.exec(path);
  if (callMatch) {
    if (req.method !== 'POST') {
      sendJson(res, req, 405, { error: 'method not allowed' });
      return;
    }
    handleCall(
      req,
      res,
      callMatch[1] ?? '',
      callMatch[2] ?? '',
      call,
      allowed,
    ).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'monitor: call handler error');
      if (!res.headersSent) sendJson(res, req, 500, { error: errMsg(err) });
    });
    return;
  }
  if (path === '/api/tail') {
    if (req.method !== 'GET') {
      sendJson(res, req, 405, { error: 'method not allowed' });
      return;
    }
    startTailStream(req, res, allowed);
    return;
  }
  sendJson(res, req, 404, { error: 'not found' });
}

function preflight(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  if (!monitorEnabled()) {
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
  return false;
}

export function handleMonitorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  call: MonitorCall,
): boolean {
  const path = (req.url ?? '').split('?', 2)[0] ?? '';
  if (!path.startsWith('/api/')) return false;
  if (preflight(req, res, path)) return true;
  const identity = authenticate(req);
  if (!identity) {
    sendJson(res, req, 401, { error: 'unauthorized' });
    return true;
  }
  routeApi(req, res, path, call, allowedAgents(identity));
  return true;
}
