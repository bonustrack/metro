import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertAgentId,
  HOLD_CODE,
  localUrl,
  MissingRuntime,
  RESTART_CODE,
  runtimeDir,
  spawnPlan,
  type DaemonPlan,
} from '../src/runtime.ts';

const KEEP = {
  dir: process.env.METRO_RUNTIME_DIR,
  xdg: process.env.XDG_CONFIG_HOME,
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


describe('the serve loop', () => {
  function counting(dir: string, codes: number[]): { plan: () => DaemonPlan; runs: () => number } {
    const script = join(dir, 'child.mjs');
    const counter = join(dir, 'count');
    writeFileSync(counter, '0');
    writeFileSync(
      script,
      "import { readFileSync, writeFileSync } from 'node:fs';\n" +
        'const [file, ...codes] = process.argv.slice(2);\n' +
        "const n = Number(readFileSync(file, 'utf8'));\n" +
        'writeFileSync(file, String(n + 1));\n' +
        'process.exit(Number(codes[n] ?? 0));\n',
    );
    return {
      plan: () => ({ command: process.execPath, args: [script, counter, ...codes.map(String)], cwd: dir, env: process.env }),
      runs: () => Number(readFileSync(counter, 'utf8')),
    };
  }

  test('75 respawns on the new plan, any other code ends the loop with that code', async () => {
    const child = counting(scratch(), [RESTART_CODE, 3]);
    expect(await spawnPlan(child.plan)).toBe(3);
    expect(child.runs()).toBe(2);
  });

  test('76 parks in the hold: start respawns, exit ends the loop cleanly', async () => {
    const child = counting(scratch(), [HOLD_CODE, HOLD_CODE, 9]);
    const ends: ('start' | 'exit')[] = ['start', 'exit'];
    const seen: number[] = [];
    const code = await spawnPlan(child.plan, () => {
      seen.push(child.runs());
      return Promise.resolve(ends.shift() ?? 'exit');
    });
    expect(code).toBe(0);
    expect(seen).toEqual([1, 2]);
  });

  test('without a hold, 76 is an exit code like any other', async () => {
    const child = counting(scratch(), [HOLD_CODE]);
    expect(await spawnPlan(child.plan)).toBe(HOLD_CODE);
  });
});
