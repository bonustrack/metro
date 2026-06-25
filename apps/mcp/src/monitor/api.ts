import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '../daemon/log.js';
import { subscribeEvents, type MetroEvent } from '../daemon/events.js';
import {
  authorized,
  cors,
  healthSnapshot,
  hostAllowed,
  monitorToken,
  parseCallArgs,
  readCallBody,
  sendJson,
} from './helpers.js';

export type MonitorCall = (
  train: string,
  action: string,
  args: Record<string, unknown>,
) => Promise<{ result: unknown }>;

const KEEPALIVE_MS = 25_000;

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
  const sse = (e: MetroEvent): void => {
    id += 1;
    res.write(`id: ${id}\nevent: live\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const stop = subscribeEvents(sse);
  const keepalive = setInterval(
    () => res.write(': keepalive\n\n'),
    KEEPALIVE_MS,
  );
  if (typeof keepalive.unref === 'function') keepalive.unref();
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
  const raw = await readCallBody(req);
  let args: Record<string, unknown> = {};
  if (raw) {
    try {
      args = parseCallArgs(raw);
    } catch (err) {
      sendJson(res, req, 400, { error: `bad JSON body: ${errMsg(err)}` });
      return;
    }
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
  if (callMatch?.[1] !== undefined && callMatch[2] !== undefined) {
    if (req.method !== 'POST') {
      sendJson(res, req, 405, { error: 'method not allowed' });
      return;
    }
    const train = callMatch[1];
    const action = callMatch[2];
    handleCall(req, res, train, action, call).catch(
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
  if (!monitorToken() || !hostAllowed(req)) {
    sendJson(res, req, 404, { error: 'not found' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, req, 200, healthSnapshot());
    return true;
  }
  const auth = authorized(req, new URLSearchParams(qs));
  if (auth) {
    sendJson(res, req, auth.status, { error: auth.msg });
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
