import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { errMsg, log } from './log.js';

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
