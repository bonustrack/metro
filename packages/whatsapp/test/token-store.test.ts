import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const dir = mkdtempSync(join(tmpdir(), 'wa-tokens-'));
process.env.WHATSAPP_TOKEN_DIR = dir;

const {
  isPersistedKeyType,
  makeTokenStore,
  persistedSubset,
  tokenStorePath,
  PERSISTED_KEY_TYPES,
} = await import('../src/token-store.ts');

const errors: string[] = [];

afterEach(() => {
  errors.length = 0;
});

describe('which key types are durable', () => {
  test('exactly the two that Baileys 7 rebuilds from nothing on a restart', () => {
    expect([...PERSISTED_KEY_TYPES]).toEqual(['tctoken', 'lid-mapping']);
  });

  test('Signal session state is deliberately NOT durable', () => {
    expect(isPersistedKeyType('tctoken')).toBe(true);
    expect(isPersistedKeyType('lid-mapping')).toBe(true);
    for (const type of [
      'session',
      'pre-key',
      'sender-key',
      'identity-key',
      'app-state-sync-key',
      'device-list',
    ])
      expect(isPersistedKeyType(type)).toBe(false);
  });
});

describe('the persisted subset', () => {
  test('carries the durable types and drops everything else', () => {
    expect(
      persistedSubset({
        tctoken: { 'a@lid': { token: 'x' } },
        'lid-mapping': { '1@s.whatsapp.net': '9@lid' },
        session: { 'a@x': 'secret' },
        'pre-key': { '1': 'secret' },
      }),
    ).toEqual({
      tctoken: { 'a@lid': { token: 'x' } },
      'lid-mapping': { '1@s.whatsapp.net': '9@lid' },
    });
  });

  test('a deleted entry is not written back as a tombstone', () => {
    expect(
      persistedSubset({ tctoken: { 'a@lid': undefined, 'b@lid': null } }),
    ).toEqual({});
  });
});

describe('the file it writes', () => {
  test('is per account, under the state dir, and cannot escape it', () => {
    expect(tokenStorePath('w0')).toBe(join(dir, 'whatsapp-tokens-w0.json'));
    expect(tokenStorePath('../../etc/x')).toBe(
      join(dir, 'whatsapp-tokens-______etc_x.json'),
    );
  });

  test('a token written now is seeded back after a restart, 0600', () => {
    const store = makeTokenStore('acct-a', (m) => errors.push(m));
    expect(store.load()).toEqual({});
    store.saveNow({
      tctoken: { '9@lid': { token: 'T', timestamp: '1' } },
      session: { 'a@x': 'secret' },
    });
    expect(errors).toEqual([]);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.path, 'utf8')).not.toContain('secret');
    const restarted = makeTokenStore('acct-a', (m) => errors.push(m));
    expect(restarted.load()).toEqual({
      tctoken: { '9@lid': { token: 'T', timestamp: '1' } },
    });
  });

  test('a debounced save lands, and an unchanged table is not rewritten', async () => {
    const store = makeTokenStore('acct-b', (m) => errors.push(m));
    store.load();
    const table = { 'lid-mapping': { '1@s.whatsapp.net': '9@lid' } };
    store.scheduleSave(table);
    store.scheduleSave(table);
    await Bun.sleep(1200);
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual(table);
    const before = statSync(store.path).mtimeMs;
    store.saveNow(table);
    expect(statSync(store.path).mtimeMs).toBe(before);
    expect(errors).toEqual([]);
  });

  test('a corrupt store file degrades to empty rather than killing the train', () => {
    const store = makeTokenStore('acct-c', (m) => errors.push(m));
    Bun.write(store.path, '{not json');
    expect(store.load()).toEqual({});
  });
});
