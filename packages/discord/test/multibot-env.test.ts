/**
 * Discord accounts load from the materialized accounts file (the DB is the runtime
 * source of truth; there is no env-var fallback). Ids come from the file records.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = ['DISCORD_ACCOUNTS_FILE', 'DISCORD_ONLY_ACCOUNTS'] as const;
let saved: Record<string, string | undefined> = {};
let dir = '';
let counter = 0;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'metro-discord-accts-'));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const fresh = () => import(`../src/accounts.ts?d${(counter += 1)}`);

describe('discord accounts file', () => {
  test('loads d0..dN from the file', async () => {
    const file = join(dir, 'discord.json');
    writeFileSync(file, JSON.stringify([
      { id: 'd0', token: 't1' }, { id: 'd1', token: 't2' }, { id: 'd2', token: 't3' },
    ]));
    process.env.DISCORD_ACCOUNTS_FILE = file;
    const { loadAccounts } = await fresh();
    expect(loadAccounts()).toEqual([
      { id: 'd0', token: 't1' }, { id: 'd1', token: 't2' }, { id: 'd2', token: 't3' },
    ]);
  });

  test('allowlist filters the file', async () => {
    const file = join(dir, 'discord2.json');
    writeFileSync(file, JSON.stringify([
      { id: 'd0', token: 't1' }, { id: 'd1', token: 't2' },
    ]));
    process.env.DISCORD_ACCOUNTS_FILE = file;
    process.env.DISCORD_ONLY_ACCOUNTS = 'd0';
    const { loadAccounts } = await fresh();
    expect(loadAccounts()).toEqual([{ id: 'd0', token: 't1' }]);
  });
});
