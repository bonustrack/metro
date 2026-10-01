import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeMetroHome } from '../src/agent-user/metro-home.ts';

let home: string;
let outside: string;

const mode = (name: string): number => statSync(join(home, name)).mode & 0o777;

function folder(name: string, bits: number): void {
  mkdirSync(join(home, name), { recursive: true });
  chmodSync(join(home, name), bits);
}

function file(name: string, bits: number): void {
  writeFileSync(join(home, name), 'x');
  chmodSync(join(home, name), bits);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metro-home-'));
  chmodSync(home, 0o755);
  folder('.metro', 0o755);
  folder('.cache/metro/serve/telegram', 0o755);
  chmodSync(join(home, '.cache'), 0o755);
  file('.cache/metro/serve/telegram/box.session', 0o644);
  folder('.npm', 0o775);
  folder('.bun', 0o755);
  folder('.npm-global/lib', 0o775);
  chmodSync(join(home, '.npm-global'), 0o775);
  file('.profile', 0o644);
  outside = mkdtempSync(join(tmpdir(), 'metro-home-target-'));
  chmodSync(outside, 0o755);
  symlinkSync(outside, join(home, 'tmp-link'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('the metro home', () => {
  test('only the CLI folder stays open to the agent user, the home stays crossable', () => {
    const closed = closeMetroHome(home, {});
    expect(closed.sort()).toEqual(['.bun', '.cache', '.metro', '.npm', '.profile']);
    expect(mode('')).toBe(0o711);
    for (const name of ['.metro', '.cache', '.npm', '.bun']) expect(mode(name)).toBe(0o700);
    expect(mode('.profile')).toBe(0o600);
    expect(mode('.npm-global')).toBe(0o775);
    expect(lstatSync(join(home, 'tmp-link')).isSymbolicLink()).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  test('a folder made after the start is closed on the next pass, and a closed home is left as is', () => {
    closeMetroHome(home, {});
    folder('.local/share/sdk', 0o755);
    expect(closeMetroHome(home, {})).toEqual(['.local']);
    expect(mode('.local')).toBe(0o700);
    expect(closeMetroHome(home, {})).toEqual([]);
  });

  test('the folder holding the CLI the daemon runs stays open too', () => {
    folder('cli/dist', 0o755);
    const closed = closeMetroHome(home, { METRO_CLI_BIN: join(home, 'cli', 'dist', 'cli.js') });
    expect(closed).not.toContain('cli');
    expect(mode('cli')).toBe(0o755);
    expect(closeMetroHome(home, { METRO_CLI_BIN: '/usr/lib/node_modules/@stage-labs/metro/dist/cli.js' })).toEqual(['cli']);
  });
});
