import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = [
  'TELEGRAM_USER_ACCOUNTS_FILE',
  'TELEGRAM_USER_ACCOUNTS',
  'TELEGRAM_USER_ONLY_ACCOUNTS',
  'TELEGRAM_USER_SESSION',
  'TELEGRAM_USER_API_ID',
  'TELEGRAM_USER_API_HASH',
] as const;

let saved: Record<string, string | undefined> = {};
let dir = '';
let counter = 0;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'metro-tg-user-'));
  process.env.TELEGRAM_USER_ACCOUNTS_FILE = join(dir, 'missing.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const fresh = () => import(`../src/accounts.ts?t${(counter += 1)}`);

describe('telegram-user account store', () => {
  test('TELEGRAM_USER_ACCOUNTS env parses an array', async () => {
    process.env.TELEGRAM_USER_ACCOUNTS = JSON.stringify([
      { id: 'alice', session: 's1', apiId: 111, apiHash: 'h1' },
      { id: 'bob', session: 's2', apiId: 222, apiHash: 'h2' },
    ]);
    const { loadAccounts } = await fresh();
    expect(loadAccounts().map((a: { id: string }) => a.id)).toEqual([
      'alice',
      'bob',
    ]);
  });

  test('single-account fast path from session + api id/hash', async () => {
    process.env.TELEGRAM_USER_SESSION = 'sess';
    process.env.TELEGRAM_USER_API_ID = '12345';
    process.env.TELEGRAM_USER_API_HASH = 'abc';
    const { loadAccounts } = await fresh();
    expect(loadAccounts()).toEqual([
      { id: 'default', session: 'sess', apiId: 12345, apiHash: 'abc' },
    ]);
  });

  test('allowlist filters the accounts file', async () => {
    const file = join(dir, 'accounts.json');
    writeFileSync(
      file,
      JSON.stringify([
        { id: 'alice', session: 's1', apiId: 111, apiHash: 'h1' },
        { id: 'bob', session: 's2', apiId: 222, apiHash: 'h2' },
      ]),
    );
    process.env.TELEGRAM_USER_ACCOUNTS_FILE = file;
    process.env.TELEGRAM_USER_ONLY_ACCOUNTS = 'bob';
    const { loadAccounts } = await fresh();
    expect(loadAccounts().map((a: { id: string }) => a.id)).toEqual(['bob']);
  });
});

describe('telegram-user line helpers', () => {
  test('lineOf builds account-scoped lines with optional topic', async () => {
    const { lineOf } = await fresh();
    expect(lineOf('acct', -100, 7)).toBe('metro://telegram-user/acct/-100/7');
    expect(lineOf('acct', -100)).toBe('metro://telegram-user/acct/-100');
  });

  test('targetOf round-trips lineOf', async () => {
    const { lineOf, targetOf } = await fresh();
    expect(targetOf(lineOf('acct', -100, 7))).toEqual({
      accountId: 'acct',
      chatId: -100,
      topicId: 7,
    });
    expect(targetOf(lineOf('acct', 42))).toEqual({
      accountId: 'acct',
      chatId: 42,
    });
  });

  test('targetOf defaults the account when unscoped', async () => {
    const { targetOf } = await fresh();
    expect(targetOf('metro://telegram-user/-100')).toEqual({
      accountId: 'default',
      chatId: -100,
    });
  });

  test('targetOf rejects non-telegram-user and malformed lines', async () => {
    const { targetOf } = await fresh();
    expect(targetOf('metro://telegram/-100')).toBeUndefined();
    expect(targetOf('metro://telegram-user/acct/not-a-number')).toBeUndefined();
  });
});
