import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockedBy, stopAll } from '../src/control.ts';

const KEEP = { state: process.env.METRO_STATE_DIR, home: process.env.HOME };
const children: ChildProcess[] = [];
const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-ctl-'));
  dirs.push(dir);
  process.env.METRO_STATE_DIR = dir;
  return dir;
}

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-home-'));
  dirs.push(dir);
  process.env.HOME = dir;
  mkdirSync(join(dir, '.metro'), { recursive: true });
  return dir;
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  if (KEEP.state === undefined) delete process.env.METRO_STATE_DIR;
  else process.env.METRO_STATE_DIR = KEEP.state;
  if (KEEP.home === undefined) delete process.env.HOME;
  else process.env.HOME = KEEP.home;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('finding the daemon that holds the machine lock', () => {
  test('no lock file means no holder', () => {
    stateDir();
    expect(lockedBy()).toBeNull();
  });

  test('a live process that is NOT metro is never treated as the daemon', () => {
    const dir = stateDir();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(sleeper);
    writeFileSync(join(dir, '.tail-lock'), String(sleeper.pid));
    expect(lockedBy()).toBeNull();
  });

  test('a dead pid is not a holder', () => {
    const dir = stateDir();
    writeFileSync(join(dir, '.tail-lock'), '999999');
    expect(lockedBy()).toBeNull();
  });

  test('a process whose command names metro IS the holder', async () => {
    const dir = stateDir();
    const fake = spawn('bash', ['-c', 'exec -a fake-metro-server.ts sleep 30'], {
      stdio: 'ignore',
    });
    children.push(fake);
    await wait(150);
    writeFileSync(join(dir, '.tail-lock'), String(fake.pid));
    expect(lockedBy()).toBe(fake.pid ?? -1);
  });
});

describe('metro stop sweeps everything, however it was started', () => {
  test('a lock-holding daemon with no pidfile is stopped and the lock removed', async () => {
    const dir = stateDir();
    homeDir();
    const fake = spawn('bash', ['-c', 'exec -a fake-metro-server.ts sleep 30'], {
      stdio: 'ignore',
    });
    children.push(fake);
    await wait(150);
    writeFileSync(join(dir, '.tail-lock'), String(fake.pid));
    const stopped = await stopAll(undefined, 3_000);
    expect(stopped.map((s) => s.via)).toEqual(['the machine lock']);
    await wait(150);
    expect(lockedBy()).toBeNull();
  });

  test('a foreign process holding the lock is left running', async () => {
    const dir = stateDir();
    homeDir();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(sleeper);
    await wait(100);
    writeFileSync(join(dir, '.tail-lock'), String(sleeper.pid));
    const stopped = await stopAll(undefined, 1_000);
    expect(stopped).toEqual([]);
    expect(sleeper.killed).toBe(false);
    expect(sleeper.exitCode).toBeNull();
  });

  test('nothing running is an honest empty result', async () => {
    stateDir();
    homeDir();
    expect(await stopAll(undefined, 500)).toEqual([]);
  });
});
