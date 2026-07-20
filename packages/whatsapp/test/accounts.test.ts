import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = ['WHATSAPP_ACCOUNTS_FILE', 'WHATSAPP_ONLY_ACCOUNTS'] as const;

let saved: Record<string, string | undefined> = {};
let dir = '';
let counter = 0;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-'));
  process.env.WHATSAPP_ACCOUNTS_FILE = join(dir, 'missing.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const fresh = () => import(`../src/accounts.ts?t${(counter += 1)}`);

describe('whatsapp account store', () => {
  test('loads accounts from the file', async () => {
    const file = join(dir, 'accounts.json');
    writeFileSync(
      file,
      JSON.stringify([
        { id: 'w0', phone: '111' },
        { id: 'w1', phone: '222' },
      ]),
    );
    process.env.WHATSAPP_ACCOUNTS_FILE = file;
    const { loadAccounts } = await fresh();
    expect(loadAccounts().map((a: { id: string }) => a.id)).toEqual(['w0', 'w1']);
  });

  test('allowlist filters the accounts file', async () => {
    const file = join(dir, 'accounts.json');
    writeFileSync(
      file,
      JSON.stringify([
        { id: 'w0', phone: '111' },
        { id: 'w1', phone: '222' },
      ]),
    );
    process.env.WHATSAPP_ACCOUNTS_FILE = file;
    process.env.WHATSAPP_ONLY_ACCOUNTS = 'w1';
    const { loadAccounts } = await fresh();
    expect(loadAccounts().map((a: { id: string }) => a.id)).toEqual(['w1']);
  });
});

describe('whatsapp line helpers', () => {
  test('lineOf builds account-scoped lines', async () => {
    const { lineOf } = await fresh();
    expect(lineOf('w0', '111@s.whatsapp.net')).toBe(
      'metro://whatsapp/w0/111@s.whatsapp.net',
    );
  });

  test('targetOf round-trips lineOf for DM and group jids', async () => {
    const { lineOf, targetOf } = await fresh();
    expect(targetOf(lineOf('w0', '111@s.whatsapp.net'))).toEqual({
      accountId: 'w0',
      jid: '111@s.whatsapp.net',
    });
    expect(targetOf(lineOf('team', '999-1@g.us'))).toEqual({
      accountId: 'team',
      jid: '999-1@g.us',
    });
  });

  test('targetOf defaults the account when unscoped', async () => {
    const { targetOf } = await fresh();
    expect(targetOf('metro://whatsapp/111@s.whatsapp.net')).toEqual({
      accountId: 'default',
      jid: '111@s.whatsapp.net',
    });
  });

  test('targetOf rejects non-whatsapp and jid-less lines', async () => {
    const { targetOf } = await fresh();
    expect(targetOf('metro://telegram/-100')).toBeUndefined();
    expect(targetOf('metro://whatsapp/w0/not-a-jid')).toBeUndefined();
  });
});
