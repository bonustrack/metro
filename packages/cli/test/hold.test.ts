import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdBanner, holdServer, holdUntilStart, STOPPED_MESSAGE, type HoldInfo } from '../src/hold.ts';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-hold-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const info = (over: Partial<HoldInfo> = {}): HoldInfo => ({
  port: 0,
  host: '127.0.0.1',
  owner: '0xef8305e140ac520225daf050e2f71d5fbcc543e7',
  version: '0.1.0-beta.67',
  funnel: null,
  lockFile: null,
  ...over,
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => {
    probe.listen(0, '127.0.0.1', r);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => {
    probe.close(() => {
      r();
    });
  });
  return port;
}

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error('condition never met');
}

const answers = async (base: string): Promise<boolean> => {
  try {
    const res = await fetch(`${base}/api/mode`);
    return res.status === 200;
  } catch {
    return false;
  }
};

function fakeTailscale(dir: string): { bin: string; calls: string } {
  const bin = join(dir, 'tailscale');
  const calls = join(dir, 'calls.log');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> ${calls}\ntrap 'exit 0' INT TERM\nwhile :; do sleep 0.1; done\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls };
}

describe('the address a stopped daemon still answers on', () => {
  test('mode says stopped, start is the one verb, everything else is 503 with the same word', async () => {
    let starts = 0;
    const server = holdServer(info(), () => {
      starts += 1;
    });
    await new Promise<void>((r) => {
      server.listen(0, '127.0.0.1', r);
    });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const mode = await fetch(`${base}/api/mode`, { headers: { origin: 'https://metro.box' } });
      expect(mode.status).toBe(200);
      expect(mode.headers.get('access-control-allow-origin')).toBe('https://metro.box');
      expect(await mode.json()).toEqual({
        mode: 'local',
        owner: '0xef8305e140ac520225daf050e2f71d5fbcc543e7',
        project: 'localdaemon',
        version: '0.1.0-beta.67',
        stopped: true,
      });
      const preflight = await fetch(`${base}/api/start`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
      const session = await fetch(`${base}/api/session`);
      expect(session.status).toBe(503);
      expect(await session.json()).toEqual({ error: STOPPED_MESSAGE, stopped: true });
      expect((await fetch(`${base}/health`)).status).toBe(503);
      expect((await fetch(`${base}/api/start`)).status).toBe(405);
      expect(starts).toBe(0);
      const start = await fetch(`${base}/api/start`, { method: 'POST' });
      expect(start.status).toBe(200);
      expect(await start.json()).toEqual({ starting: true });
      expect(starts).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe('holding the port between stop and start', () => {
  test('keeps the lock and the funnel up, then hands both back on start', async () => {
    const dir = scratch();
    const { bin, calls } = fakeTailscale(dir);
    const lockFile = join(dir, '.tail-lock');
    const port = await freePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const lines: string[] = [];
    const held = holdUntilStart(info({ port, funnel: bin, lockFile }), {
      signals: new EventEmitter(),
      log: (line) => {
        lines.push(line);
      },
    });
    await until(() => answers(base));
    expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
    await until(() => Promise.resolve(existsSync(calls)));
    expect(readFileSync(calls, 'utf8').trim()).toBe(`funnel ${String(port)}`);
    expect(lines[0]).toContain(`http://127.0.0.1:${String(port)} and the Funnel address`);
    expect((await fetch(`${base}/api/start`, { method: 'POST' })).status).toBe(200);
    expect(await held).toBe('start');
    expect(existsSync(lockFile)).toBe(false);
    expect(await answers(base)).toBe(false);
  });

  test('a signal ends the hold instead, and the loopback address alone is fine', async () => {
    const dir = scratch();
    const lockFile = join(dir, '.tail-lock');
    const port = await freePort();
    const signals = new EventEmitter();
    const held = holdUntilStart(info({ port, lockFile }), {
      signals,
      log: () => undefined,
    });
    await until(() => answers(`http://127.0.0.1:${String(port)}`));
    signals.emit('SIGTERM');
    expect(await held).toBe('exit');
    expect(existsSync(lockFile)).toBe(false);
  });

  test('the banner names what is held', () => {
    expect(holdBanner(info({ port: 8420, funnel: '/usr/bin/tailscale' }))).toContain(
      'Holding http://127.0.0.1:8420 and the Funnel address until Start on the Server page',
    );
    expect(holdBanner(info({ port: 8420 }))).not.toContain('Funnel');
  });
});
