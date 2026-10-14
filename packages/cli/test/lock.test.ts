import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAlive, takeLock, withLock } from '../src/lock.ts';

const HOUR = 60 * 60_000;
const DEAD = 2 ** 22 + 7;

let dir = '';
let lock = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-lock-'));
  lock = join(dir, 'x.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('this process is alive and a pid that cannot exist is not', () => {
  expect(processAlive(process.pid)).toBe(true);
  expect(processAlive(DEAD)).toBe(false);
});

test('one holder at a time, and a lock left by a dead process or older than its limit is taken over', () => {
  expect(takeLock(lock, 2 * HOUR)).toBe(true);
  expect(takeLock(lock, 2 * HOUR)).toBe(false);
  expect(takeLock(lock, 2 * HOUR, Date.now() + 3 * HOUR)).toBe(true);
  writeFileSync(lock, String(DEAD));
  expect(takeLock(lock, 2 * HOUR)).toBe(true);
  writeFileSync(lock, '');
  expect(takeLock(lock, 2 * HOUR)).toBe(false);
});

test('withLock takes a stale lock over at once and releases it after the work, even when the work throws', () => {
  const wait = { staleMs: HOUR, waitMs: 5_000, pollMs: 10 };
  writeFileSync(lock, String(DEAD));
  expect(withLock(lock, wait, () => readFileSync(lock, 'utf8'))).toBe(String(process.pid));
  expect(existsSync(lock)).toBe(false);
  writeFileSync(lock, String(process.pid));
  const old = new Date(Date.now() - 2 * HOUR);
  utimesSync(lock, old, old);
  expect(() => withLock(lock, wait, () => { throw new Error('boom'); })).toThrow('boom');
  expect(existsSync(lock)).toBe(false);
});

test('withLock waits for a live holder, says so once, then gives up after its bound; a lock that is no longer its own is left alone', () => {
  writeFileSync(lock, String(process.pid));
  let told = 0;
  const started = Date.now();
  expect(() => withLock(lock, { staleMs: HOUR, waitMs: 200, pollMs: 20, waiting: () => { told += 1; } }, () => 'ran')).toThrow('still holds');
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(told).toBe(1);
  expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  rmSync(lock);
  withLock(lock, { staleMs: HOUR, waitMs: 200, pollMs: 20 }, () => {
    writeFileSync(lock, String(DEAD));
  });
  expect(readFileSync(lock, 'utf8')).toBe(String(DEAD));
});
