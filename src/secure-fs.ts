import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { errMsg, log } from './log.js';

export const METRO_HOME =
  process.env.METRO_HOME_DIR ?? join(homedir(), '.metro');

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
  }
}

export function chmodIfExists(path: string, mode = 0o600): void {
  if (!existsSync(path)) return;
  try {
    if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  } catch {
  }
}

export function writeSecure(path: string, data: string): void {
  ensureSecureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
  }
  renameSync(tmp, path);
  chmodIfExists(path, 0o600);
}

export function readJson<T>(
  path: string,
  fallback: T,
  opts?: { warn?: string },
): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if (opts?.warn) log.warn({ err: errMsg(err), path }, opts.warn);
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}
