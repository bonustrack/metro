import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { openSecret, sealSecret } from '../src/connectors/secrets.ts';
import { readConnectorsSetup } from '../src/connectors/setup.ts';

const OWNER = 'org_01TESTOWNER000000';
const STRANGER = 'org_01TESTSTRANGER00';
const KEY = randomBytes(32).toString('base64');

describe('connector secrets', () => {
  test('a sealed secret opens only with its key, for its own organization and connector', () => {
    const key = randomBytes(32);
    const sealed = sealSecret(key, OWNER, 'conn0000001', { token: 'x' });
    expect(openSecret(key, OWNER, 'conn0000001', sealed)).toEqual({ token: 'x' });
    expect(sealSecret(key, OWNER, 'conn0000001', { token: 'x' })).not.toBe(sealed);
    expect(() => openSecret(key, OWNER, 'conn0000002', sealed)).toThrow('could not be opened');
    expect(() => openSecret(key, STRANGER, 'conn0000001', sealed)).toThrow('could not be opened');
    expect(() => openSecret(randomBytes(32), OWNER, 'conn0000001', sealed)).toThrow('could not be opened');
  });

  test('a changed byte, a cut tag or another format is refused', () => {
    const key = randomBytes(32);
    const sealed = sealSecret(key, OWNER, 'conn0000001', 'secret');
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    const changed = Buffer.from(raw);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    for (const bad of [`v1.${changed.toString('base64url')}`, `v1.${raw.subarray(0, 20).toString('base64url')}`, sealed.replace('v1.', 'v2.'), `${sealed}.x`, 'v1.!!'])
      expect(() => openSecret(key, OWNER, 'conn0000001', bad)).toThrow('could not be opened');
  });

  test('a value too large to keep is refused', () => {
    expect(() => sealSecret(randomBytes(32), OWNER, 'conn0000001', 'x'.repeat(70_000))).toThrow('too large');
  });
});

describe('the switch and the key', () => {
  test('off unless METRO_CONNECTORS_ENABLED is true, and then the key is not read', () => {
    expect(readConnectorsSetup({})).toMatchObject({ enabled: false, key: null });
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: '1', METRO_CONNECTORS_KEY: KEY })).toMatchObject({ enabled: false, key: null });
  });

  test('METRO_CONNECTORS_KEY is 32 bytes in base64, as openssl rand -base64 32 prints them', () => {
    const setup = readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_KEY: `${KEY}\n` });
    expect(setup.enabled).toBe(true);
    expect(setup.key?.equals(Buffer.from(KEY, 'base64'))).toBe(true);
  });

  test('no key or a malformed one means no connector secret, with a reason', () => {
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true' })).toMatchObject({ enabled: true, key: null });
    for (const bad of [randomBytes(16).toString('base64'), randomBytes(32).toString('hex'), KEY.slice(0, -2), `${KEY}AAAA`]) {
      const setup = readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_KEY: bad });
      expect(setup).toMatchObject({ enabled: true, key: null });
      expect(setup.note).toContain('openssl rand -base64 32');
    }
  });
});
