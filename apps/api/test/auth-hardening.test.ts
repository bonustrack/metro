import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { log } from '@metro-labs/core/log';
import { announceAccounts } from '../src/auth/providers.ts';
import { openState, sealState, stateKeyFrom } from '../src/auth/state-seal.ts';

const NOW = Date.parse('2026-11-16T09:00:00.000Z');

afterEach(() => {
  delete process.env.OPERATOR_USER_ID;
});

describe('the sealed sign-in state', () => {
  const key = stateKeyFrom(null, randomBytes(32)) ?? Buffer.alloc(32);

  test('it opens only with its key, unchanged, within 10 minutes', () => {
    const sealed = sealState(key, { r: 'https://metro.box/', n: 'nonce' }, NOW);
    expect(openState(key, sealed, NOW + 60_000)).toMatchObject({ r: 'https://metro.box/', n: 'nonce' });
    expect(openState(key, sealed, NOW + 10 * 60_000)).toBeNull();
    expect(openState(Buffer.alloc(32, 7), sealed, NOW)).toBeNull();
    expect(openState(key, `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`, NOW)).toBeNull();
    expect(openState(key, 'v1.', NOW)).toBeNull();
    expect(openState(key, 'plain-random-state', NOW)).toBeNull();
  });

  test('its key comes from METRO_AUTH_SIGNING_KEY with HKDF, else METRO_CONNECTORS_KEY, the same on every machine', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const connectors = randomBytes(32);
    expect(stateKeyFrom(privateKey, connectors)).toEqual(stateKeyFrom(privateKey, null));
    expect(stateKeyFrom(privateKey, connectors)).not.toEqual(stateKeyFrom(null, connectors));
    expect(stateKeyFrom(null, connectors)?.length).toBe(32);
    expect(stateKeyFrom(null, null)).toBeNull();
  });
});

describe('the boot log', () => {
  test('warns when OPERATOR_USER_ID is unset or not a user id', () => {
    const warn = spyOn(log, 'warn');
    try {
      announceAccounts(['google'], true, {});
      announceAccounts(['google'], true, { OPERATOR_USER_ID: 'admin@stage.box' });
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('OPERATOR_USER_ID'))).toHaveLength(2);
      warn.mockClear();
      announceAccounts(['google'], true, { OPERATOR_USER_ID: 'user_01KADMIN0000000000000000AB' });
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('OPERATOR_USER_ID'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
