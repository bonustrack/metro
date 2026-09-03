import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE = (): string => join(homedir(), '.metro');

export function serveStateDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.cache') : xdg;
  return join(base, 'metro', 'serve');
}

const serveLockPath = (): string => join(serveStateDir(), '.tail-lock');

const pidPath = (agentId: string): string =>
  join(STATE(), `run-${agentId}.pid`);

export const logPath = (agentId: string): string =>
  join(STATE(), 'logs', `${agentId}.log`);

function ensureStateDirs(): void {
  mkdirSync(STATE(), { recursive: true, mode: 0o700 });
  mkdirSync(join(STATE(), 'logs'), { recursive: true, mode: 0o700 });
}

function readPid(agentId: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath(agentId), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runningPid(agentId: string): number | null {
  const pid = readPid(agentId);
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  rmSync(pidPath(agentId), { force: true });
  return null;
}

function writePid(agentId: string, pid: number): void {
  writeFileSync(pidPath(agentId), String(pid));
}

function clearPid(agentId: string): void {
  rmSync(pidPath(agentId), { force: true });
}

export interface DetachOptions {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function detach(opts: DetachOptions): number {
  ensureStateDirs();
  const out = openSync(logPath(opts.agentId), 'a');
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  const pid = child.pid ?? 0;
  if (pid === 0) throw new Error('could not start the metro daemon');
  writePid(opts.agentId, pid);
  return pid;
}

async function stopPid(pid: number, waitMs: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(pid, 'SIGKILL');
}

const lockPath = (): string =>
  process.env.METRO_STATE_DIR?.trim()
    ? join(process.env.METRO_STATE_DIR.trim(), '.tail-lock')
    : join(homedir(), '.cache', 'metro', '.tail-lock');

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

const looksLikeMetro = (command: string): boolean =>
  command.includes('server.ts') || command.includes('metro');

function holderOf(lockFile: string): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(lockFile, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return null;
  return looksLikeMetro(commandOf(pid)) ? pid : null;
}

export const lockedBy = (): number | null => holderOf(lockPath());

export const serveLockedBy = (): number | null => holderOf(serveLockPath());

export interface StoppedDaemon {
  pid: number;
  via: string;
}

function trackedAgents(agentId: string | undefined): Set<string> {
  const tracked = new Set<string>();
  if (agentId !== undefined) tracked.add(agentId);
  try {
    for (const name of readdirSync(STATE())) {
      const found = /^run-(.+)\.pid$/.exec(name);
      if (found?.[1] !== undefined) tracked.add(found[1]);
    }
  } catch {
    return tracked;
  }
  return tracked;
}

export async function stopAll(
  agentId: string | undefined,
  waitMs = 10_000,
): Promise<StoppedDaemon[]> {
  const stopped: StoppedDaemon[] = [];
  const seen = new Set<number>();
  for (const id of trackedAgents(agentId)) {
    const pid = runningPid(id);
    if (pid === null || seen.has(pid)) continue;
    seen.add(pid);
    await stopPid(pid, waitMs);
    clearPid(id);
    stopped.push({ pid, via: id });
  }
  const holder = lockedBy();
  if (holder !== null && !seen.has(holder)) {
    seen.add(holder);
    await stopPid(holder, waitMs);
    rmSync(lockPath(), { force: true });
    stopped.push({ pid: holder, via: 'the machine lock' });
  }
  const served = serveLockedBy();
  if (served !== null && !seen.has(served)) {
    await stopPid(served, waitMs);
    rmSync(serveLockPath(), { force: true });
    stopped.push({ pid: served, via: 'metro serve' });
  }
  return stopped;
}

export function tail(agentId: string, follow: boolean): Promise<number> {
  const path = logPath(agentId);
  if (!existsSync(path))
    throw new Error(
      `no log for ${agentId} yet — it is only written when started with --detach`,
    );
  const args = follow ? ['-n', '200', '-f', path] : ['-n', '200', path];
  const child = spawn('tail', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}

export interface Health {
  status: string;
  uptime: number;
}

export async function probe(url: string): Promise<Health | null> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}
