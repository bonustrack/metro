/**
 * Multi-bot env config. Verifies the comma-separated DISCORD_BOT_TOKENS env
 * fallback plus the shared csv/genIds helpers in account-store. No accounts file
 * is present, so the `fallback` path is exercised; account ids are the generated
 * d0/d1 form. (Telegram's fallback lives in @metro-labs/telegram's own tests.)
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csv, genIds } from '@metro-labs/station-kit/account-store';

const ENV_KEYS = [
  'DISCORD_ACCOUNTS_FILE', 'DISCORD_BOT_TOKENS',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Point the *_ACCOUNTS_FILE at a fresh empty dir so no file exists → fallback path.
  const dir = mkdtempSync(join(tmpdir(), 'metro-multibot-'));
  process.env.DISCORD_ACCOUNTS_FILE = join(dir, 'discord.json');
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('account-store helpers', () => {
  test('csv trims, drops empties, and dedupes', () => {
    expect(csv(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(csv('a,a,b')).toEqual(['a', 'b']);
    expect(csv(undefined)).toEqual([]);
  });
  test('genIds → prefix0..N-1', () => {
    expect(genIds('d', 1)).toEqual(['d0']);
    expect(genIds('t', 3)).toEqual(['t0', 't1', 't2']);
  });
});

describe('discord fallback', () => {
  test('single token → one d0 account', async () => {
    process.env.DISCORD_BOT_TOKENS = 'tok-d';
    const { loadAccounts } = await import('../src/stations/discord/accounts.js?d1');
    expect(loadAccounts()).toEqual([{ id: 'd0', token: 'tok-d' }]);
  });
  test('many tokens → d0..dN', async () => {
    process.env.DISCORD_BOT_TOKENS = 't1,t2,t3';
    const { loadAccounts } = await import('../src/stations/discord/accounts.js?d2');
    expect(loadAccounts()).toEqual([
      { id: 'd0', token: 't1' }, { id: 'd1', token: 't2' }, { id: 'd2', token: 't3' },
    ]);
  });
});
