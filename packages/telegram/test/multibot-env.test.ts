/**
 * Telegram multi-bot env config. Verifies the comma-separated TELEGRAM_BOT_TOKENS
 * env fallback. No accounts file is present, so the `fallback` path is exercised;
 * account ids are the generated t0/t1 form.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = ['TELEGRAM_ACCOUNTS_FILE', 'TELEGRAM_BOT_TOKENS'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Point TELEGRAM_ACCOUNTS_FILE at a fresh empty dir so no file exists → fallback path.
  const dir = mkdtempSync(join(tmpdir(), 'metro-telegram-multibot-'));
  process.env.TELEGRAM_ACCOUNTS_FILE = join(dir, 'telegram.json');
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('telegram fallback', () => {
  test('many tokens → t0..tN', async () => {
    process.env.TELEGRAM_BOT_TOKENS = 'a,b';
    const { loadAccounts } = await import('../src/accounts.ts?t1');
    expect(loadAccounts()).toEqual([{ id: 't0', token: 'a' }, { id: 't1', token: 'b' }]);
  });
});
