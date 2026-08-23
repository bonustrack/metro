import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lockHeldByLiveDaemon } from '../src/daemon/paths.ts';

const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });

afterAll(() => {
  sleeper.kill();
});

describe('the boot lock only yields to a real metro process', () => {
  test('a LIVE process that is not metro does not hold the lock', () => {
    expect(sleeper.pid).toBeGreaterThan(0);
    expect(lockHeldByLiveDaemon(sleeper.pid ?? 0)).toBe(false);
  });

  test('a pid that is not running does not hold the lock', () => {
    expect(lockHeldByLiveDaemon(999_999)).toBe(false);
  });

  test('a nonsense pid does not hold the lock', () => {
    for (const pid of [Number.NaN, 0, -1, 1.5])
      expect(lockHeldByLiveDaemon(pid)).toBe(false);
  });

  test('our own pid never counts as a foreign holder', () => {
    expect(lockHeldByLiveDaemon(process.pid)).toBe(false);
  });
});
