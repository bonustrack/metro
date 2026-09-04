import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function serveStateDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.cache') : xdg;
  return join(base, 'metro', 'serve');
}

const serveLockPath = (): string => join(serveStateDir(), '.tail-lock');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

interface StoppedDaemon {
  pid: number;
  via: string;
}

export async function stopAll(waitMs = 10_000): Promise<StoppedDaemon[]> {
  const stopped: StoppedDaemon[] = [];
  const holder = lockedBy();
  if (holder !== null) {
    await stopPid(holder, waitMs);
    rmSync(lockPath(), { force: true });
    stopped.push({ pid: holder, via: 'the machine lock' });
  }
  const served = serveLockedBy();
  if (served !== null && served !== holder) {
    await stopPid(served, waitMs);
    rmSync(serveLockPath(), { force: true });
    stopped.push({ pid: served, via: 'metro serve' });
  }
  return stopped;
}
