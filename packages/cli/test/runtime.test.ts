import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertAgentId,
  localUrl,
  MissingRuntime,
  readRunToken,
  runtimeDir,
  writeRunToken,
} from '../src/runtime.ts';

const KEEP = {
  dir: process.env.METRO_RUNTIME_DIR,
  xdg: process.env.XDG_CONFIG_HOME,
  token: process.env.METRO_RUN_TOKEN,
  url: process.env.METRO_URL,
};
const made: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-runtime-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const [k, v] of Object.entries({
    METRO_RUNTIME_DIR: KEEP.dir,
    XDG_CONFIG_HOME: KEEP.xdg,
    METRO_RUN_TOKEN: KEEP.token,
    METRO_URL: KEEP.url,
  }))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the agent id is validated before anything else happens', () => {
  test('a real id passes', () => {
    expect(assertAgentId('HURgz4SdQvG')).toBe('HURgz4SdQvG');
  });

  test('anything else is refused with a message naming where to find it', () => {
    for (const bad of [undefined, '', 'short', '-leadingdash', 'way-too-long-id'])
      expect(() => assertAgentId(bad)).toThrow(/not an agent id/);
  });
});

const ENTRY = join('node_modules', '@metro-labs', 'mcp', 'src');

describe('locating the bundled daemon', () => {
  test('the runtime shipped in the package is found with no configuration', () => {
    delete process.env.METRO_RUNTIME_DIR;
    expect(runtimeDir()).toMatch(/packages\/cli\/runtime$/);
  });

  test('a directory holding no daemon is refused, never guessed at', () => {
    process.env.METRO_RUNTIME_DIR = scratch();
    expect(() => runtimeDir()).toThrow(MissingRuntime);
  });

  test('METRO_RUNTIME_DIR wins when it does hold one', () => {
    const dir = scratch();
    mkdirSync(join(dir, ENTRY), { recursive: true });
    writeFileSync(join(dir, ENTRY, 'server.ts'), '');
    process.env.METRO_RUNTIME_DIR = dir;
    expect(runtimeDir()).toBe(dir);
  });
});

describe('the local endpoint', () => {
  test('defaults to loopback 8420 and follows METRO_WEBHOOK_PORT', () => {
    delete process.env.METRO_WEBHOOK_PORT;
    expect(localUrl()).toBe('http://127.0.0.1:8420');
    process.env.METRO_WEBHOOK_PORT = '9999';
    expect(localUrl()).toBe('http://127.0.0.1:9999');
    delete process.env.METRO_WEBHOOK_PORT;
  });
});

describe('the run token is stored per agent and per metro', () => {
  test('a written token reads back for that agent', () => {
    process.env.XDG_CONFIG_HOME = scratch();
    delete process.env.METRO_RUN_TOKEN;
    writeRunToken('HURgz4SdQvG', 'run-token-1');
    expect(readRunToken('HURgz4SdQvG')).toBe('run-token-1');
  });

  test('another agent on the same machine does not share it', () => {
    process.env.XDG_CONFIG_HOME = scratch();
    delete process.env.METRO_RUN_TOKEN;
    writeRunToken('HURgz4SdQvG', 'run-token-1');
    expect(readRunToken('nONaK77lT9Q')).toBeNull();
  });

  test('a token stored against another metro is not reused', () => {
    process.env.XDG_CONFIG_HOME = scratch();
    delete process.env.METRO_RUN_TOKEN;
    process.env.METRO_URL = 'https://mcp.metro.box';
    writeRunToken('HURgz4SdQvG', 'run-token-1');
    process.env.METRO_URL = 'https://other.example.com';
    expect(readRunToken('HURgz4SdQvG')).toBeNull();
  });

  test('METRO_RUN_TOKEN wins, so an unattended start needs no store', () => {
    process.env.XDG_CONFIG_HOME = scratch();
    process.env.METRO_RUN_TOKEN = 'from-the-environment';
    expect(readRunToken('HURgz4SdQvG')).toBe('from-the-environment');
  });
});
