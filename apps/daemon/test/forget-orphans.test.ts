import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetOrphans } from '../src/stations/registry.ts';

const ENVS = ['OUTLOOK_STATE_DIR', 'WHATSAPP_TOKEN_DIR', 'THREEMA_GROUPS_DIR'] as const;

let dir = '';

const file = (name: string): string => join(dir, name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-forget-'));
  for (const env of ENVS) process.env[env] = dir;
});

afterEach(() => {
  for (const env of ENVS) delete process.env[env];
  rmSync(dir, { recursive: true, force: true });
});

describe('the boot sweep of station files', () => {
  test('files of accounts no longer attached go, a live account keeps its own', () => {
    for (const name of [
      'outlook-state-live01.json',
      'outlook-state-gone01.json',
      'whatsapp-tokens-live02.json',
      'whatsapp-tokens-gone02.json',
      'threema-groups-live03.json',
      'threema-groups-gone03.json',
      'xmtp-production-abcd.db3',
      'outlook-accounts.json',
    ])
      writeFileSync(file(name), '{}');
    forgetOrphans([
      { station: 'outlook', id: 'live01' },
      { station: 'whatsapp', id: 'live02' },
      { station: 'threema', id: 'live03' },
    ]);
    expect(existsSync(file('outlook-state-live01.json'))).toBe(true);
    expect(existsSync(file('whatsapp-tokens-live02.json'))).toBe(true);
    expect(existsSync(file('threema-groups-live03.json'))).toBe(true);
    expect(existsSync(file('outlook-state-gone01.json'))).toBe(false);
    expect(existsSync(file('whatsapp-tokens-gone02.json'))).toBe(false);
    expect(existsSync(file('threema-groups-gone03.json'))).toBe(false);
    expect(existsSync(file('xmtp-production-abcd.db3'))).toBe(true);
    expect(existsSync(file('outlook-accounts.json'))).toBe(true);
  });

  test('an account of another station never protects a file of this one', () => {
    writeFileSync(file('outlook-state-shared.json'), '{}');
    forgetOrphans([{ station: 'whatsapp', id: 'shared' }]);
    expect(existsSync(file('outlook-state-shared.json'))).toBe(false);
  });

  test('a missing directory is not an error', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(() => {
      forgetOrphans([]);
    }).not.toThrow();
  });
});
