import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pkg from '../package.json' with { type: 'json' };
import { readClaims } from './broker/claims.js';
import {
  recentEvents,
  subscribeEvents,
  tailIncludes,
  type Mode,
  type TailOpts,
} from './event-bus.js';
import type { MetroEvent } from './events.js';
import { ipcCall } from './ipc.js';
import { asLine, Line } from './lines.js';
import { errMsg, log } from './log.js';
import {
  buildTailOpts,
  nonNegInt,
  parseCallArgs,
  readCallBody,
  resolveSince,
} from './monitor-api-helpers.js';
import { readBotIds } from './paths.js';
import { accountStationNames } from './stations/registry.js';

const MONITOR_HOSTS = new Set(
  (process.env.METRO_MONITOR_HOSTS ?? 'monitor.metro.box,localhost,127.0.0.1')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function cors(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
function send(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...cors(req) });
  res.end(JSON.stringify(body));
}
function tokenEq(given: string, want: string): boolean {
  const g = Buffer.from(given),
    w = Buffer.from(want);
  return g.length === w.length && timingSafeEqual(g, w);
}
function authorized(
  req: IncomingMessage,
  q?: URLSearchParams,
): { status: number; msg: string } | null {
  const token = process.env.METRO_MONITOR_TOKEN;
  if (!token)
    return {
      status: 503,
      msg: 'monitor endpoints not configured (METRO_MONITOR_TOKEN unset)',
    };
  const header = ([] as string[]).concat(req.headers.authorization ?? [])[0];
  if (header?.startsWith('Bearer ') && tokenEq(header.slice(7), token))
    return null;
  const qt = q?.get('token');
  if (qt && tokenEq(qt, token)) return null;
  return { status: 401, msg: 'unauthorized' };
}
export function pickMode(
  strict: boolean,
  unclaimed: boolean,
  all: boolean,
  self: Line | null,
  onErr: (msg: string) => never | Mode,
): Mode {
  if ([strict, unclaimed, all].filter(Boolean).length > 1) {
    return onErr('strict/unclaimed/all are mutually exclusive');
  }
  if (strict)
    return self ? 'mine-only' : onErr('strict requires --as <user-uri>');
  if (unclaimed) return 'unclaimed';
  if (all || !self) return 'all';
  return 'mine-or-unclaimed';
}
function reportError(
  res: ServerResponse,
  req: IncomingMessage,
  context: string,
  err: unknown,
): void {
  log.warn({ err: errMsg(err) }, context);
  try {
    if (!res.headersSent) send(res, req, 500, { error: errMsg(err) });
    else res.end();
  } catch {}
}
function handleAccounts(res: ServerResponse, req: IncomingMessage): void {
  gatherAccounts()
    .then((accounts) => {
      send(res, req, 200, { accounts });
    })
    .catch((err: unknown) => {
      reportError(res, req, 'monitor: accounts handler error', err);
    });
}
function handleTailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  q: URLSearchParams,
): void {
  try {
    handleTail(req, res, q);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'monitor: tail handler error');
    try {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    } catch {}
  }
}
function routeGet(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  q: URLSearchParams,
): boolean {
  if (path === '/api/state') handleState(res, req, q);
  else if (path === '/api/accounts') handleAccounts(res, req);
  else if (path === '/api/tail') handleTailRoute(req, res, q);
  else return false;
  return true;
}
function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  q: URLSearchParams,
): void {
  const callMatch = /^\/api\/call\/([^/]+)\/([^/]+)$/.exec(path);
  if (callMatch && req.method !== 'POST') {
    send(res, req, 405, { error: 'method not allowed' });
    return;
  }
  if (callMatch) {
    handleCall(req, res, callMatch[1], callMatch[2]).catch((err: unknown) => {
      reportError(res, req, 'monitor: call handler error', err);
    });
    return;
  }
  if (req.method === 'GET' && routeGet(req, res, path, q)) return;
  if (req.method !== 'GET' && (path === '/api/state' || path === '/api/tail')) {
    send(res, req, 405, { error: 'method not allowed' });
    return;
  }
  send(res, req, 404, { error: 'not found' });
}
function runHealth(res: ServerResponse, req: IncomingMessage): void {
  handleHealth(res, req).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'monitor: health handler error');
    try {
      send(res, req, 500, { ok: false, error: errMsg(err) });
    } catch {}
  });
}
function hostAllowed(req: IncomingMessage): boolean {
  const host =
    (req.headers[':authority' as keyof typeof req.headers] as
      | string
      | undefined) ?? req.headers.host;
  return !host || MONITOR_HOSTS.has(host.split(':')[0].toLowerCase());
}
export function handleMonitorRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = req.url ?? '';
  const [path, qs = ''] = url.split('?', 2);
  if (req.method === 'GET' && (path === '/health' || path === '/api/health')) {
    runHealth(res, req);
    return true;
  }
  if (!url.startsWith('/api/')) return false;
  if (!hostAllowed(req)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req));
    res.end();
    return true;
  }
  const q = new URLSearchParams(qs);
  const auth = authorized(req, q);
  if (auth) {
    send(res, req, auth.status, { error: auth.msg });
    return true;
  }
  routeApi(req, res, path, q);
  return true;
}
export async function gatherAccounts(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  await Promise.all(
    accountStationNames().map(async (station) => {
      try {
        const resp = await ipcCall({
          op: 'forward-call',
          train: station,
          action: 'accounts',
          args: {},
        });
        const accounts =
          resp.ok && 'response' in resp
            ? (resp.response.result as { accounts?: unknown[] } | undefined)
                ?.accounts
            : undefined;
        out[station] = Array.isArray(accounts) ? accounts : [];
      } catch {
        out[station] = [];
      }
    }),
  );
  return out;
}
async function handleHealth(
  res: ServerResponse,
  req: IncomingMessage,
): Promise<void> {
  const accounts = await gatherAccounts();
  send(res, req, 200, {
    ok: true,
    service: 'metro',
    version: pkg.version,
    uptime_s: Math.round(process.uptime()),
    accounts,
  });
}
function handleState(
  res: ServerResponse,
  req: IncomingMessage,
  q: URLSearchParams,
): void {
  const limit = Math.min(nonNegInt(q.get('limit')) ?? 100, 500);
  const recent = recentEvents(limit),
    claims = readClaims();
  const lines = new Set<string>([
    ...recent.map((e) => e.line),
    ...Object.keys(claims),
  ]);
  send(res, req, 200, {
    claims,
    lines: [...lines],
    recent_history: recent,
    bot_ids: readBotIds(),
    version: pkg.version,
  });
}
function startTailStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TailOpts,
  self: Line | null,
  replayBacklog: boolean,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...cors(req),
    'x-accel-buffering': 'no',
  });
  res.write(
    `: metro monitor tail (mode=${opts.mode}${self ? `, as=${self}` : ''})\n: ${'-'.repeat(4096)}\n\n`,
  );
  let id = 0;
  const claims = readClaims();
  const sse = (e: MetroEvent): void => {
    if (!tailIncludes(e, opts, claims)) return;
    id += 1;
    res.write(`id: ${id}\nevent: history\ndata: ${JSON.stringify(e)}\n\n`);
  };
  if (replayBacklog)
    for (const e of recentEvents(500).slice().reverse()) sse(e);
  const stop = subscribeEvents(sse);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
  const cleanup = (): void => {
    stop();
    clearInterval(keepalive);
    try {
      res.end();
    } catch {}
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}
function handleTail(
  req: IncomingMessage,
  res: ServerResponse,
  q: URLSearchParams,
): void {
  const asParam = q.get('as');
  const self = asParam ? asLine(asParam) : null;
  const isOn = (k: string): boolean =>
    q.get(k) === 'true' || q.get('mode') === k;
  const mode = pickMode(
    isOn('strict'),
    isOn('unclaimed'),
    isOn('all'),
    self,
    () => 'all',
  );
  const since = resolveSince(q);
  if ('error' in since) {
    send(res, req, 400, { error: since.error });
    return;
  }
  const opts: TailOpts = buildTailOpts(q, mode, self);
  startTailStream(req, res, opts, self, since.replayBacklog);
}
type IpcResp = Awaited<ReturnType<typeof ipcCall>>;
function callError(resp: IpcResp): string | null {
  if (!resp.ok) return resp.error;
  if (!('response' in resp)) return 'malformed daemon response';
  return resp.response.error ?? null;
}
function callResult(resp: IpcResp): unknown {
  return 'response' in resp ? (resp.response.result ?? null) : null;
}
async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  train: string,
  action: string,
): Promise<void> {
  const raw = await readCallBody(req);
  let args: unknown = {};
  if (raw) {
    try {
      args = parseCallArgs(raw);
    } catch (err) {
      send(res, req, 400, { error: `bad JSON body: ${errMsg(err)}` });
      return;
    }
  }
  const resp = await ipcCall({ op: 'forward-call', train, action, args });
  const err = callError(resp);
  if (err !== null) {
    send(res, req, 502, { error: err });
    return;
  }
  send(res, req, 200, { result: callResult(resp) });
}
