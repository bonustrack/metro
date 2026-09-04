import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { findTailscale, parseServeArgs, servePlan } from '../src/serve.ts';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serveStateDir } from '../src/control.ts';
import { SERVER_ENTRY } from '../src/runtime.ts';

const RUNTIME = {
  dir: '/opt/metro/runtime',
  entry: join('/opt/metro/runtime', SERVER_ENTRY),
  trains: join('/opt/metro/runtime', 'trains'),
  manifest: null,
};

const KEYS = [
  'METRO_WEBHOOK_PORT',
  'METRO_RUN_TOKEN',
  'METRO_AGENT',
  'DATABASE_URL',
  'METRO_HTTP_HOST',
  'METRO_STATE_DIR',
  'XDG_CACHE_HOME',
] as const;
const KEEP = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS)
    if (KEEP[k] === undefined) delete process.env[k];
    else process.env[k] = KEEP[k];
});

describe('metro serve arguments', () => {
  test('no arguments means 8420, or METRO_WEBHOOK_PORT when set', () => {
    delete process.env.METRO_WEBHOOK_PORT;
    expect(parseServeArgs([])).toEqual({ port: 8420, tunnel: null, owner: null });
    process.env.METRO_WEBHOOK_PORT = '8422';
    expect(parseServeArgs([])).toEqual({ port: 8422, tunnel: null, owner: null });
  });

  test('--port in its three spellings wins over the environment', () => {
    process.env.METRO_WEBHOOK_PORT = '8422';
    expect(parseServeArgs(['--port', '8421'])).toEqual({ port: 8421, tunnel: null, owner: null });
    expect(parseServeArgs(['--port=9000'])).toEqual({ port: 9000, tunnel: null, owner: null });
    expect(parseServeArgs(['-p', '1'])).toEqual({ port: 1, tunnel: null, owner: null });
    expect(parseServeArgs(['--tunnel', '--port', '8421'])).toEqual({ port: 8421, tunnel: 'quick', owner: null });
    expect(parseServeArgs(['--tunnel', 'tailscale'])).toEqual({ port: 8422, tunnel: 'tailscale', owner: null });
    expect(parseServeArgs(['--tunnel=tailscale', '--port', '8421'])).toEqual({ port: 8421, tunnel: 'tailscale', owner: null });
    expect(parseServeArgs(['--tunnel', 'quick'])).toEqual({ port: 8422, tunnel: 'quick', owner: null });
    expect(() => parseServeArgs(['--tunnel', 'ngrok'])).toThrow(/not a tunnel kind/);
    expect(parseServeArgs(['--owner', '0xEF8305E140ac520225DAf050e2f71d5fBCC543e7'])).toEqual({
      port: 8422,
      tunnel: null,
      owner: '0xef8305e140ac520225daf050e2f71d5fbcc543e7',
    });
    expect(parseServeArgs(['--owner=0xef8305e140ac520225daf050e2f71d5fbcc543e7']).owner).toBe('0xef8305e140ac520225daf050e2f71d5fbcc543e7');
    expect(() => parseServeArgs(['--owner', 'less.eth'])).toThrow(/not an Ethereum address/);
  });

  test('a bad port or an unknown flag is refused with the usage', () => {
    for (const bad of [['--port', 'x'], ['--port', '70000'], ['--port'], ['--port=']])
      expect(() => parseServeArgs(bad)).toThrow(/not a port/);
    expect(() => parseServeArgs(['--detach'])).toThrow(/unknown argument '--detach'/);
  });
});

describe('the daemon a serve plan starts', () => {
  test('is local, on loopback, with trains and state of its own, and never linked or hosted', () => {
    process.env.METRO_RUN_TOKEN = 'rt-left-over';
    process.env.METRO_AGENT = 'HURgz4SdQvG';
    process.env.DATABASE_URL = 'postgres://prod';
    delete process.env.METRO_HTTP_HOST;
    delete process.env.METRO_STATE_DIR;
    process.env.XDG_CACHE_HOME = '/tmp/cache-home';
    const plan = servePlan({ runtime: RUNTIME, port: 8421, tunnel: null, owner: null });
    expect(plan.env.METRO_TUNNEL).toBeUndefined();
    expect(plan.env.METRO_OWNER).toBeUndefined();
    expect(servePlan({ runtime: RUNTIME, port: 8421, tunnel: 'quick', owner: '0xef8305e140ac520225daf050e2f71d5fbcc543e7' }).env.METRO_OWNER).toBe('0xef8305e140ac520225daf050e2f71d5fbcc543e7');
    expect(plan.args).toEqual([SERVER_ENTRY]);
    expect(plan.cwd).toBe('/opt/metro/runtime');
    expect(plan.env.METRO_MODE).toBe('local');
    expect(plan.env.METRO_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(plan.env.METRO_CLI_BIN).toBe(process.argv[1] ?? '');
    expect(plan.env.METRO_WEBHOOK_PORT).toBe('8421');
    expect(plan.env.METRO_HTTP_HOST).toBe('127.0.0.1');
    expect(plan.env.METRO_TRAINS_DIR).toBe(join('/opt/metro/runtime', 'trains'));
    expect(plan.env.METRO_STATE_DIR).toBe('/tmp/cache-home/metro/serve');
    expect(plan.env.METRO_RUN_TOKEN).toBeUndefined();
    expect(plan.env.METRO_AGENT).toBeUndefined();
    expect(plan.env.DATABASE_URL).toBeUndefined();
    expect(plan.env.METRO_RUNTIME_STORE).toBeUndefined();
    expect(plan.env.METRO_RUNTIME_MANIFEST).toBeUndefined();
  });

  test('a runtime store names itself and its manifest to the daemon, so channels attached later install their SDK', () => {
    const store = { dir: '/home/u/.metro/runtime', entry: '/home/u/.metro/runtime/x', trains: '/home/u/.metro/runtime/trains', manifest: '/opt/cli/runtime/stations.json' };
    const plan = servePlan({ runtime: store, port: 8420, tunnel: null, owner: null });
    expect(plan.cwd).toBe('/home/u/.metro/runtime');
    expect(plan.env.METRO_TRAINS_DIR).toBe('/home/u/.metro/runtime/trains');
    expect(plan.env.METRO_RUNTIME_STORE).toBe('/home/u/.metro/runtime');
    expect(plan.env.METRO_RUNTIME_MANIFEST).toBe('/opt/cli/runtime/stations.json');
  });

  test('a tailscale funnel names the binary the CLI found', () => {
    const plan = servePlan({ runtime: RUNTIME, port: 8420, tunnel: 'tailscale', tailscaleBin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', owner: null });
    expect(plan.env.METRO_TUNNEL).toBe('tailscale');
    expect(plan.env.METRO_TAILSCALE_BIN).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(servePlan({ runtime: RUNTIME, port: 8420, tunnel: 'quick', owner: null }).env.METRO_TAILSCALE_BIN).toBeUndefined();
  });

  test('an explicit host or state dir is kept', () => {
    process.env.METRO_HTTP_HOST = '0.0.0.0';
    process.env.METRO_STATE_DIR = '/var/lib/metro';
    const plan = servePlan({ runtime: RUNTIME, port: 8420, tunnel: 'quick', owner: null });
    expect(plan.env.METRO_TUNNEL).toBe('quick');
    expect(plan.env.METRO_HTTP_HOST).toBe('0.0.0.0');
    expect(plan.env.METRO_STATE_DIR).toBe('/var/lib/metro');
  });

  test('the state dir falls back to ~/.cache without XDG_CACHE_HOME', () => {
    delete process.env.XDG_CACHE_HOME;
    expect(serveStateDir()).toMatch(/\/\.cache\/metro\/serve$/);
  });
});

describe('finding tailscale', () => {
  let dir = '';
  const fake = (name: string, script: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a connected node passes, a signed-out one and a missing binary fail with the next step', () => {
    dir = mkdtempSync(join(tmpdir(), 'metro-fake-ts-'));
    const running = fake('ts-running', `if [ "$1" = "version" ]; then echo 1.102.2; exit 0; fi\necho '{"BackendState":"Running"}'`);
    const loggedOut = fake('ts-out', `if [ "$1" = "version" ]; then echo 1.102.2; exit 0; fi\necho '{"BackendState":"NeedsLogin"}'`);
    expect(findTailscale([join(dir, 'missing'), running])).toBe(running);
    expect(() => findTailscale([loggedOut])).toThrow(/NeedsLogin[^]*tailscale up/);
    expect(() => findTailscale([join(dir, 'missing')])).toThrow(/needs Tailscale on this machine/);
  });
});
