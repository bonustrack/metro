import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseServeArgs, servePlan } from '../src/serve.ts';
import { serveStateDir } from '../src/control.ts';
import { SERVER_ENTRY } from '../src/runtime.ts';

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
    expect(parseServeArgs([])).toEqual({ port: 8420, tunnel: false, owner: null });
    process.env.METRO_WEBHOOK_PORT = '8422';
    expect(parseServeArgs([])).toEqual({ port: 8422, tunnel: false, owner: null });
  });

  test('--port in its three spellings wins over the environment', () => {
    process.env.METRO_WEBHOOK_PORT = '8422';
    expect(parseServeArgs(['--port', '8421'])).toEqual({ port: 8421, tunnel: false, owner: null });
    expect(parseServeArgs(['--port=9000'])).toEqual({ port: 9000, tunnel: false, owner: null });
    expect(parseServeArgs(['-p', '1'])).toEqual({ port: 1, tunnel: false, owner: null });
    expect(parseServeArgs(['--tunnel', '--port', '8421'])).toEqual({ port: 8421, tunnel: true, owner: null });
    expect(parseServeArgs(['--owner', '0xEF8305E140ac520225DAf050e2f71d5fBCC543e7'])).toEqual({
      port: 8422,
      tunnel: false,
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
    const plan = servePlan({ dir: '/opt/metro/runtime', port: 8421, tunnel: false, owner: null });
    expect(plan.env.METRO_TUNNEL).toBeUndefined();
    expect(plan.env.METRO_OWNER).toBeUndefined();
    expect(servePlan({ dir: '/opt/metro/runtime', port: 8421, tunnel: true, owner: '0xef8305e140ac520225daf050e2f71d5fbcc543e7' }).env.METRO_OWNER).toBe('0xef8305e140ac520225daf050e2f71d5fbcc543e7');
    expect(plan.args).toEqual([SERVER_ENTRY]);
    expect(plan.cwd).toBe('/opt/metro/runtime');
    expect(plan.env.METRO_MODE).toBe('local');
    expect(plan.env.METRO_WEBHOOK_PORT).toBe('8421');
    expect(plan.env.METRO_HTTP_HOST).toBe('127.0.0.1');
    expect(plan.env.METRO_TRAINS_DIR).toBe(join('/opt/metro/runtime', 'trains'));
    expect(plan.env.METRO_STATE_DIR).toBe('/tmp/cache-home/metro/serve');
    expect(plan.env.METRO_RUN_TOKEN).toBeUndefined();
    expect(plan.env.METRO_AGENT).toBeUndefined();
    expect(plan.env.DATABASE_URL).toBeUndefined();
  });

  test('an explicit host or state dir is kept', () => {
    process.env.METRO_HTTP_HOST = '0.0.0.0';
    process.env.METRO_STATE_DIR = '/var/lib/metro';
    const plan = servePlan({ dir: '/opt/metro/runtime', port: 8420, tunnel: true });
    expect(plan.env.METRO_TUNNEL).toBe('quick');
    expect(plan.env.METRO_HTTP_HOST).toBe('0.0.0.0');
    expect(plan.env.METRO_STATE_DIR).toBe('/var/lib/metro');
  });

  test('the state dir falls back to ~/.cache without XDG_CACHE_HOME', () => {
    delete process.env.XDG_CACHE_HOME;
    expect(serveStateDir()).toMatch(/\/\.cache\/metro\/serve$/);
  });
});
