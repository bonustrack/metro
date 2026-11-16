import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { log } from '@metro-labs/core/log';
import { announceAccounts } from '../src/auth/accounts-mode.ts';
import { addressBucket, clientAddress, fromCloudflare } from '../src/auth/rate-limit.ts';
import { openState, sealState, stateKeyFrom } from '../src/auth/state-seal.ts';

const NOW = Date.parse('2026-11-16T09:00:00.000Z');

const request = (headers: Record<string, string>, socket = '10.0.0.9'): IncomingMessage => ({ headers, socket: { remoteAddress: socket } }) as unknown as IncomingMessage;

afterEach(() => {
  delete process.env.OPERATOR_USER_ID;
});

describe('the client address behind Fly and Cloudflare', () => {
  test('cf-connecting-ip counts only when the Fly client address is one of Cloudflare\'s', () => {
    expect(clientAddress(request({ 'fly-client-ip': '198.51.100.7', 'cf-connecting-ip': '203.0.113.5' }))).toBe('198.51.100.7');
    expect(clientAddress(request({ 'fly-client-ip': '172.64.1.1', 'cf-connecting-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(clientAddress(request({ 'fly-client-ip': '2606:4700::6810:1', 'cf-connecting-ip': '203.0.113.6' }))).toBe('203.0.113.6');
    expect(clientAddress(request({ 'cf-connecting-ip': '203.0.113.5' }))).toBe('10.0.0.9');
    expect(clientAddress(request({}, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
    expect(['104.16.0.1', '162.158.10.10', '2a06:98c1::1'].every(fromCloudflare)).toBe(true);
    expect(['8.8.8.8', '2001:db8::1', 'not an address'].some(fromCloudflare)).toBe(false);
  });

  test('an IPv6 client is counted by its /64, so rotating the rest of the address buys nothing', () => {
    expect(addressBucket('2001:db8:1:2:aaaa::1')).toBe('2001:0db8:0001:0002::/64');
    expect(addressBucket('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:0db8:0001:0002::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(clientAddress(request({ 'fly-client-ip': '172.64.1.1', 'cf-connecting-ip': '2001:db8:1:2::99' }))).toBe('2001:0db8:0001:0002::/64');
  });
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

describe('the boot log with Metro accounts', () => {
  test('warns when OPERATOR_USER_ID is unset or not a user id, and not with WorkOS', () => {
    const warn = spyOn(log, 'warn');
    try {
      announceAccounts('metro', ['google'], true, {});
      announceAccounts('metro', ['google'], true, { OPERATOR_USER_ID: 'admin@stage.box' });
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('OPERATOR_USER_ID'))).toHaveLength(2);
      warn.mockClear();
      announceAccounts('metro', ['google'], true, { OPERATOR_USER_ID: 'user_01KADMIN0000000000000000AB' });
      announceAccounts('workos', [], false, {});
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('OPERATOR_USER_ID'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
