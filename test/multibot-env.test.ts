/**
 * Phase-1 multi-bot env config (additive). Verifies the comma-separated token
 * env fallbacks for discord/telegram and the mnemonic-derive env for xmtp, plus
 * the shared id/token helpers in account-store. No accounts file is present, so
 * the `fallback` path is exercised; the singular legacy env stays a one-account
 * alias.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csv, tokensFromEnv, idsFor, deriveIndices } from '../src/stations/account-store.js';

const ENV_KEYS = [
  'DISCORD_ACCOUNTS_FILE', 'DISCORD_BOT_TOKEN', 'DISCORD_BOT_TOKENS', 'DISCORD_BOT_IDS',
  'TELEGRAM_ACCOUNTS_FILE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKENS', 'TELEGRAM_BOT_IDS',
  'XMTP_ACCOUNTS_FILE', 'XMTP_PRIVATE_KEY', 'XMTP_DERIVE_COUNT', 'XMTP_DERIVE_INDICES', 'XMTP_ENV',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Point the *_ACCOUNTS_FILE at a fresh empty dir so no file exists → fallback path.
  const dir = mkdtempSync(join(tmpdir(), 'metro-multibot-'));
  process.env.DISCORD_ACCOUNTS_FILE = join(dir, 'discord.json');
  process.env.TELEGRAM_ACCOUNTS_FILE = join(dir, 'telegram.json');
  process.env.XMTP_ACCOUNTS_FILE = join(dir, 'xmtp.json');
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const die = ((msg: string) => { throw new Error(msg); }) as (m: string) => never;

describe('account-store helpers', () => {
  test('csv trims and drops empties', () => {
    expect(csv(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(csv(undefined)).toEqual([]);
  });
  test('tokensFromEnv: plural wins, else singular, else []', () => {
    process.env.DISCORD_BOT_TOKENS = 'a,b';
    expect(tokensFromEnv(['DISCORD_BOT_TOKENS'], 'DISCORD_BOT_TOKEN')).toEqual(['a', 'b']);
    delete process.env.DISCORD_BOT_TOKENS;
    process.env.DISCORD_BOT_TOKEN = 'solo';
    expect(tokensFromEnv(['DISCORD_BOT_TOKENS'], 'DISCORD_BOT_TOKEN')).toEqual(['solo']);
    delete process.env.DISCORD_BOT_TOKEN;
    expect(tokensFromEnv(['DISCORD_BOT_TOKENS'], 'DISCORD_BOT_TOKEN')).toEqual([]);
  });
  test('idsFor: single→default, N→prefixN, explicit wins', () => {
    expect(idsFor('d', 1, undefined, die)).toEqual(['default']);
    expect(idsFor('d', 2, undefined, die)).toEqual(['d0', 'd1']);
    expect(idsFor('d', 2, 'alpha,beta', die)).toEqual(['alpha', 'beta']);
    expect(() => idsFor('d', 2, 'only-one', die)).toThrow(/2 tokens but only 1 ids/);
    expect(() => idsFor('d', 2, 'x,x', die)).toThrow(/duplicate id/);
  });
});

describe('discord fallback', () => {
  test('singular token → one default account', async () => {
    process.env.DISCORD_BOT_TOKEN = 'tok-d';
    const { loadAccounts } = await import('../src/stations/discord/accounts.js?d1');
    expect(loadAccounts()).toEqual([{ id: 'default', token: 'tok-d' }]);
  });
  test('plural tokens → d0..dN', async () => {
    process.env.DISCORD_BOT_TOKENS = 't1,t2,t3';
    const { loadAccounts } = await import('../src/stations/discord/accounts.js?d2');
    expect(loadAccounts()).toEqual([
      { id: 'd0', token: 't1' }, { id: 'd1', token: 't2' }, { id: 'd2', token: 't3' },
    ]);
  });
  test('explicit ids via DISCORD_BOT_IDS', async () => {
    process.env.DISCORD_BOT_TOKENS = 't1,t2';
    process.env.DISCORD_BOT_IDS = 'alpha,beta';
    const { loadAccounts } = await import('../src/stations/discord/accounts.js?d3');
    expect(loadAccounts()).toEqual([{ id: 'alpha', token: 't1' }, { id: 'beta', token: 't2' }]);
  });
});

describe('telegram fallback', () => {
  test('plural tokens → t0..tN', async () => {
    process.env.TELEGRAM_BOT_TOKENS = 'a,b';
    const { loadAccounts } = await import('../src/stations/telegram/accounts.js?t1');
    expect(loadAccounts()).toEqual([{ id: 't0', token: 'a' }, { id: 't1', token: 'b' }]);
  });
});

// The xmtp accounts module imports @xmtp/node-sdk (resolved only in the train's
// ~/.metro/node_modules, not the repo), so the derive-index logic is factored
// into the pure `deriveIndices` helper and tested directly here.
describe('xmtp deriveIndices', () => {
  test('XMTP_DERIVE_COUNT → 0..N-1', () => {
    expect(deriveIndices(undefined, '3', die)).toEqual([0, 1, 2]);
  });
  test('XMTP_DERIVE_INDICES explicit wins over count', () => {
    expect(deriveIndices('0,3,7', '5', die)).toEqual([0, 3, 7]);
  });
  test('neither set → []', () => {
    expect(deriveIndices(undefined, undefined, die)).toEqual([]);
  });
  test('rejects negative/non-int indices and duplicates', () => {
    expect(() => deriveIndices('0,-1', undefined, die)).toThrow(/non-negative integers/);
    expect(() => deriveIndices('1,1', undefined, die)).toThrow(/duplicate index/);
    expect(() => deriveIndices(undefined, '0', die)).toThrow(/positive integer/);
  });
});
