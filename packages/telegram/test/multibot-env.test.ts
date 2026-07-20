import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = ['TELEGRAM_ACCOUNTS_FILE', 'TELEGRAM_ONLY_ACCOUNTS'] as const;
let saved: Record<string, string | undefined> = {};
let dir = '';
let counter = 0;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'metro-telegram-accts-'));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const fresh = () => import(`../src/accounts.ts?t${(counter += 1)}`);

describe('telegram accounts file', () => {
  test('loads t0..tN from the file', async () => {
    const file = join(dir, 'telegram.json');
    writeFileSync(file, JSON.stringify([
      { id: 't0', token: 'a' }, { id: 't1', token: 'b' },
    ]));
    process.env.TELEGRAM_ACCOUNTS_FILE = file;
    const { loadAccounts } = await fresh();
    expect(loadAccounts()).toEqual([{ id: 't0', token: 'a' }, { id: 't1', token: 'b' }]);
  });

  test('allowlist filters the file', async () => {
    const file = join(dir, 'telegram2.json');
    writeFileSync(file, JSON.stringify([
      { id: 't0', token: 'a' }, { id: 't1', token: 'b' },
    ]));
    process.env.TELEGRAM_ACCOUNTS_FILE = file;
    process.env.TELEGRAM_ONLY_ACCOUNTS = 't1';
    const { loadAccounts } = await fresh();
    expect(loadAccounts()).toEqual([{ id: 't1', token: 'b' }]);
  });
});
