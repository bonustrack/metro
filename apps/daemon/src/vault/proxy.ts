import { spawn, type ChildProcess } from 'node:child_process';
import { stringOf } from '@metro-labs/http/api-http';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { MANAGEMENT_KEY_ENV } from './config.js';
import { ports } from './paths.js';

export interface ProxyRequest {
  at: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  action: string;
  swapped: string[];
}

const RECENT_MAX = 200;
const BACKOFF_MAX_MS = 30_000;

const recent: ProxyRequest[] = [];
const state: { child: ChildProcess | null; wanted: { bin: string; config: string } | null; key: string; backoff: number; lastError: string | null; startedAt: number } = {
  child: null,
  wanted: null,
  key: randomBytes(24).toString('hex'),
  backoff: 1000,
  lastError: null,
  startedAt: 0,
};

function swappedIds(transforms: unknown): string[] {
  if (!Array.isArray(transforms)) return [];
  return transforms.flatMap((t) => {
    const swapped = isRecord(t) && isRecord(t.annotations) && Array.isArray(t.annotations.swapped) ? t.annotations.swapped : [];
    return swapped.flatMap((s) => (isRecord(s) && typeof s.secret === 'string' ? [basename(s.secret)] : []));
  });
}

export function requestOf(line: string): ProxyRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.msg !== 'request' || !isRecord(parsed.audit)) return null;
  const audit = parsed.audit;
  if (audit.method === 'CONNECT') return null;
  return {
    at: stringOf(parsed.time),
    method: stringOf(audit.method),
    host: stringOf(audit.host),
    path: stringOf(audit.path),
    status: typeof audit.status_code === 'number' ? audit.status_code : null,
    action: stringOf(audit.action),
    swapped: swappedIds(parsed.request_transforms),
  };
}

function noteLine(line: string): void {
  const request = requestOf(line);
  if (request !== null) {
    recent.push(request);
    if (recent.length > RECENT_MAX) recent.shift();
    return;
  }
  if (/"level":"(WARN|ERROR)"/.test(line)) log.warn({ line: line.slice(0, 500) }, 'vault: iron-proxy');
}

function launch(): void {
  const wanted = state.wanted;
  if (wanted === null || state.child !== null) return;
  const child = spawn(wanted.bin, ['-config', wanted.config], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [MANAGEMENT_KEY_ENV]: state.key } });
  state.child = child;
  state.startedAt = Date.now();
  for (const stream of [child.stdout, child.stderr]) if (stream !== null) createInterface({ input: stream }).on('line', noteLine);
  child.on('error', (err) => {
    state.lastError = errMsg(err);
  });
  child.on('exit', (code) => {
    state.child = null;
    if (state.wanted === null) return;
    state.lastError = `iron-proxy stopped (exit ${String(code)})`;
    log.warn({ code, retryInMs: state.backoff }, 'vault: iron-proxy stopped, starting it again');
    const wait = state.backoff;
    state.backoff = Date.now() - state.startedAt > 60_000 ? 1000 : Math.min(state.backoff * 2, BACKOFF_MAX_MS);
    setTimeout(launch, wait).unref();
  });
}

async function reload(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(ports().management)}/v1/reload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function listening(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${String(ports().management)}/v1/reload`, { method: 'GET', signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function waitListening(ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await listening()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function runProxy(bin: string, config: string): Promise<void> {
  const fresh = state.child === null;
  state.wanted = { bin, config };
  if (fresh) launch();
  else if (await reload()) {
    state.lastError = null;
    return;
  } else {
    state.child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, state.backoff + 500));
  }
  if (!(await waitListening())) throw new Error(state.lastError ?? 'iron-proxy did not start');
  state.lastError = null;
}

export function stopProxy(): void {
  state.wanted = null;
  state.child?.kill('SIGTERM');
}

export const proxyRunning = (): boolean => state.child !== null;
export const proxyError = (): string | null => state.lastError;
export const recentRequests = (): ProxyRequest[] => [...recent].reverse();
