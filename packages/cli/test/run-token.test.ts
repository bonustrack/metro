import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunTokens } from '../src/store.ts';

const METRO = 'https://mcp.metro.test';
const saved = { ...process.env };
let dir = '';

afterEach(() => {
  process.env = { ...saved };
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function home(): string {
  dir = mkdtempSync(join(tmpdir(), 'metro-run-'));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.METRO_URL = METRO;
  delete process.env.METRO_RUN_TOKEN;
  const base = join(dir, 'metro');
  mkdirSync(base, { recursive: true });
  return base;
}

const write = (base: string, name: string, body: unknown): void => {
  writeFileSync(join(base, name), JSON.stringify(body));
};

describe('the run tokens a machine holds', () => {
  test('one runtime file for this metro is the token metro mcp may use', () => {
    const base = home();
    write(base, 'runtime-agent000001.json', { token: 'run-1', url: METRO });
    expect(readRunTokens()).toEqual(['run-1']);
  });

  test('a token for another metro, a stray file, the CLI sign-in and junk are all ignored', () => {
    const base = home();
    write(base, 'runtime-agent000001.json', { token: 'run-1', url: 'https://other.metro.test' });
    write(base, 'runtime-short.json', { token: 'x', url: METRO });
    write(base, 'credentials.json', { token: 'cli', url: METRO });
    writeFileSync(join(base, 'runtime-agent000002.json'), 'not json');
    expect(readRunTokens()).toEqual([]);
  });

  test('two agents on one machine are both reported, so the caller can refuse to guess', () => {
    const base = home();
    write(base, 'runtime-agent000001.json', { token: 'run-1', url: METRO });
    write(base, 'runtime-agent000002.json', { token: 'run-2', url: METRO });
    expect(readRunTokens().sort()).toEqual(['run-1', 'run-2']);
  });

  test('METRO_RUN_TOKEN wins over every file', () => {
    const base = home();
    write(base, 'runtime-agent000001.json', { token: 'run-1', url: METRO });
    process.env.METRO_RUN_TOKEN = 'env-run';
    expect(readRunTokens()).toEqual(['env-run']);
  });

  test('no config directory at all is simply no tokens', () => {
    home();
    rmSync(dir, { recursive: true, force: true });
    expect(readRunTokens()).toEqual([]);
  });
});
