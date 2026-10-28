import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { readOrNull } from './runtime-install.js';

interface LockWait {
  staleMs: number;
  waitMs: number;
  pollMs: number;
  waiting?: () => void;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const EMPTY_GRACE_MS = 5_000;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockHeld(path: string, now: number, staleMs: number): boolean {
  try {
    const age = now - statSync(path).mtimeMs;
    if (age >= staleMs) return false;
    const text = readFileSync(path, 'utf8').trim();
    if (text === '') return age < EMPTY_GRACE_MS;
    const pid = Number(text);
    return !Number.isInteger(pid) || pid <= 0 || processAlive(pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function takeLock(path: string, staleMs: number, now = Date.now(), retry = true): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, String(process.pid));
    } catch (err) {
      closeSync(fd);
      rmSync(path, { force: true });
      throw err;
    }
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!retry || lockHeld(path, now, staleMs)) return false;
    rmSync(path, { force: true });
    return takeLock(path, staleMs, now, false);
  }
}

export function withLock<T>(path: string, wait: LockWait, run: () => T): T {
  const deadline = Date.now() + wait.waitMs;
  let told = false;
  while (!takeLock(path, wait.staleMs)) {
    if (Date.now() >= deadline) throw new Error(`Another process still holds ${path}; try again later.`);
    if (!told) wait.waiting?.();
    told = true;
    Atomics.wait(pause, 0, 0, wait.pollMs);
  }
  try {
    return run();
  } finally {
    if (readOrNull(path)?.trim() === String(process.pid)) rmSync(path, { force: true });
  }
}
