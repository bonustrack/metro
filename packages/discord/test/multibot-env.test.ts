/**
 * Discord multi-bot env config. Verifies the comma-separated DISCORD_BOT_TOKENS
 * env fallback. No accounts file is present, so the `fallback` path is exercised;
 * account ids are the generated d0/d1 form.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = ['DISCORD_ACCOUNTS_FILE', 'DISCORD_BOT_TOKENS'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Point DISCORD_ACCOUNTS_FILE at a fresh empty dir so no file exists → fallback path.
  const dir = mkdtempSync(join(tmpdir(), 'metro-discord-multibot-'));
  process.env.DISCORD_ACCOUNTS_FILE = join(dir, 'discord.json');
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('discord fallback', () => {
  test('single token → one d0 account', async () => {
    process.env.DISCORD_BOT_TOKENS = 'tok-d';
    const { loadAccounts } = await import('../src/accounts.ts?d1');
    expect(loadAccounts()).toEqual([{ id: 'd0', token: 'tok-d' }]);
  });
  test('many tokens → d0..dN', async () => {
    process.env.DISCORD_BOT_TOKENS = 't1,t2,t3';
    const { loadAccounts } = await import('../src/accounts.ts?d2');
    expect(loadAccounts()).toEqual([
      { id: 'd0', token: 't1' }, { id: 'd1', token: 't2' }, { id: 'd2', token: 't3' },
    ]);
  });
});
