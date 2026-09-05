import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const FUNNEL_RETRY_MS = 2_000;
const FUNNEL_EXIT_WAIT_MS = 5_000;
const LISTEN_ATTEMPTS = 10;
const LISTEN_RETRY_MS = 500;
const STOPPED = 503;

export const STOPPED_MESSAGE =
  'metro is stopped on this machine. Start it from the Server page on metro.box, or run metro serve.';

export interface HoldInfo {
  port: number;
  host: string;
  owner: string | null;
  version: string;
  funnel: string | null;
  lockFile: string | null;
}

export interface HoldDeps {
  signals?: EventEmitter;
  log?: (line: string) => void;
}

export type HoldEnd = 'start' | 'exit';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function corsHeaders(req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(body));
}

export function holdRequest(req: IncomingMessage, res: ServerResponse, info: HoldInfo, onStart: () => void): void {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req)).end();
    return;
  }
  if (path === '/api/mode' && req.method === 'GET') {
    sendJson(req, res, 200, {
      mode: 'local',
      owner: info.owner,
      project: 'localdaemon',
      version: info.version,
      stopped: true,
    });
    return;
  }
  if (path === '/api/start') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'method not allowed' });
      return;
    }
    sendJson(req, res, 200, { starting: true });
    onStart();
    return;
  }
  if (path === '/health' || path === '/healthz') {
    sendJson(req, res, STOPPED, { status: 'stopped', version: info.version });
    return;
  }
  sendJson(req, res, STOPPED, { error: STOPPED_MESSAGE, stopped: true });
}

export const holdServer = (info: HoldInfo, onStart: () => void): Server =>
  createServer((req, res) => {
    holdRequest(req, res, info, onStart);
  });

const lastLine = (chunk: Buffer | string): string => String(chunk).trim().split('\n').at(-1) ?? '';

class HeldFunnel {
  private child: ChildProcess | null = null;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private exits = 0;

  constructor(
    private readonly bin: string,
    private readonly port: number,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    if (this.closed) return;
    const child = spawn(this.bin, ['funnel', String(this.port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let last = '';
    const read = (chunk: Buffer | string): void => {
      const line = lastLine(chunk);
      if (line !== '') last = line;
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (err) => {
      this.child = null;
      this.closed = true;
      this.log(`funnel could not start (${err.message}); the loopback address is still held`);
    });
    child.on('exit', () => {
      this.child = null;
      if (this.closed) return;
      this.exits += 1;
      if (this.exits > 1) this.log(`funnel exited (${last}); retrying in ${String(FUNNEL_RETRY_MS / 1000)}s`);
      this.timer = setTimeout(() => {
        this.start();
      }, FUNNEL_RETRY_MS);
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    const child = this.child;
    this.child = null;
    if (child === null) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
      }, FUNNEL_EXIT_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGINT');
    });
  }
}

async function listen(server: Server, info: HoldInfo): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(info.port, info.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return;
    } catch (err) {
      if (attempt >= LISTEN_ATTEMPTS) throw err;
      await wait(LISTEN_RETRY_MS);
    }
  }
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });

function releaseLock(lockFile: string): void {
  try {
    if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) rmSync(lockFile, { force: true });
  } catch {
    return;
  }
}

export const holdBanner = (info: HoldInfo): string =>
  `metro is stopped. Holding http://${info.host}:${String(info.port)}${info.funnel === null ? '' : ' and the Funnel address'} ` +
  'until Start on the Server page; Ctrl-C or metro stop ends metro serve';

export async function holdUntilStart(info: HoldInfo, deps: HoldDeps = {}): Promise<HoldEnd> {
  const signals = deps.signals ?? process;
  const log =
    deps.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  let finish: (end: HoldEnd) => void = () => undefined;
  const ended = new Promise<HoldEnd>((resolve) => {
    finish = resolve;
  });
  const server = holdServer(info, () => {
    finish('start');
  });
  const onSignal = (): void => {
    finish('exit');
  };
  if (info.lockFile !== null) writeFileSync(info.lockFile, String(process.pid));
  await listen(server, info);
  const funnel = info.funnel === null ? null : new HeldFunnel(info.funnel, info.port, log);
  funnel?.start();
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  log(holdBanner(info));
  const end = await ended;
  signals.off('SIGINT', onSignal);
  signals.off('SIGTERM', onSignal);
  await funnel?.stop();
  await close(server);
  if (info.lockFile !== null) releaseLock(info.lockFile);
  return end;
}
