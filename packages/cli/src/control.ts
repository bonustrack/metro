import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE = (): string => join(homedir(), '.metro');

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

export async function stop(agentId: string, waitMs = 10_000): Promise<boolean> {
  const pid = runningPid(agentId);
  if (pid === null) return false;
  process.kill(pid, 'SIGTERM');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) {
      clearPid(agentId);
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(pid, 'SIGKILL');
  clearPid(agentId);
  return true;
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
