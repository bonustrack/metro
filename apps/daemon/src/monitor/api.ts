import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { subscribeEvents, type MetroEvent } from '@metro-labs/core/events';
import { eventInScope } from '../agents/scope.js';
import { hasAnyKey } from '../agents/keys.js';
import {
  allowedAgents,
  authenticate,
} from '../mcp/request-identity.js';

const KEEPALIVE_MS = 25_000;

const monitorEnabled = (): boolean => hasAnyKey();

function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, OPTIONS',
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

function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  allowed: Set<string>,
): void {
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

function preflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (!monitorEnabled()) {
    sendJson(res, req, 404, { error: 'not found' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  return false;
}

export function handleMonitorRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? '').split('?', 2)[0] ?? '';
  if (!path.startsWith('/api/')) return false;
  if (preflight(req, res)) return true;
  const identity = authenticate(req);
  if (!identity) {
    sendJson(res, req, 401, { error: 'unauthorized' });
    return true;
  }
  routeApi(req, res, path, allowedAgents(identity));
  return true;
}
