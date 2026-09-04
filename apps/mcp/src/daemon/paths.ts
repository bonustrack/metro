import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

export const STATE_DIR =
  process.env.METRO_STATE_DIR ?? join(homedir(), '.cache', 'metro');
mkdirSync(STATE_DIR, { recursive: true });

export const configDir = (): string =>
  process.env.METRO_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'metro');

export function trainsDir(): string {
  const env = process.env.METRO_TRAINS_DIR?.trim();
  if (env !== undefined && env !== '') return env;
  return fileURLToPath(new URL('../../trains', import.meta.url));
}

export const isLocalMode = (): boolean =>
  process.env.METRO_MODE?.trim() === 'local';

function readLockPid(lockFile: string): number {
  try {
    return Number(readFileSync(lockFile, 'utf8').trim());
  } catch {
    return NaN;
  }
}

function namesMetro(text: string): boolean {
  return text.includes('server.ts') || text.includes('metro');
}

function holderIsMetro(pid: number): boolean {
  try {
    return namesMetro(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    return holderCommand(pid);
  }
}

function holderCommand(pid: number): boolean {
  try {
    return namesMetro(
      execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return false;
  }
}

export function lockHeldByLiveDaemon(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return holderIsMetro(pid);
}

function writeOwnLock(lockFile: string): void {
  const fd = openSync(lockFile, 'wx');
  writeSync(fd, String(process.pid));
  closeSync(fd);
  process.on('exit', () => {
    try {
      if (readFileSync(lockFile, 'utf8').trim() === String(process.pid))
        unlinkSync(lockFile);
    } catch {
    }
  });
}

export function acquireLock(lockFile: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeOwnLock(lockFile);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = readLockPid(lockFile);
      if (lockHeldByLiveDaemon(pid)) {
        log.info(
          { pid },
          'a healthy `metro` daemon is already running; exiting (no second dispatcher)',
        );
        process.exit(0);
      }
      try {
        unlinkSync(lockFile);
      } catch {
      }
    }
  }
  throw new Error(
    `metro: could not acquire dispatcher lock (${lockFile}) after retries`,
  );
}
