import { describe, expect, test } from 'bun:test';
import {
  ATTACHABLE_STATIONS,
  isAttachStation,
  newXmtpPrivateKey,
  prepareAccount,
  StationAttachError,
} from '../src/stations/attach.ts';
import { isStationName, parseAccountId } from '../src/db/account-attach.ts';

const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

describe('attachable stations', () => {
  test('the attachable set is a strict subset of the known stations', () => {
    for (const station of ATTACHABLE_STATIONS)
      expect(isStationName(station)).toBe(true);
  });

  test('stations Metro knows but cannot attach yet are refused', () => {
    for (const station of ['line', 'whatsapp', 'telegram-user'])
      expect(isAttachStation(station)).toBe(false);
  });

  test('junk is never an attachable station', () => {
    for (const station of ['', 'XMTP', 'telegram ', 42, null, undefined, {}])
      expect(isAttachStation(station)).toBe(false);
  });
});

describe('generated xmtp identities', () => {
  test('is a 0x-prefixed 32-byte hex key viem will accept', () => {
    for (let i = 0; i < 50; i++)
      expect(newXmtpPrivateKey()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('lands inside the secp256k1 scalar field', () => {
    for (let i = 0; i < 50; i++) {
      const value = BigInt(newXmtpPrivateKey());
      expect(value > 0n).toBe(true);
      expect(value < SECP256K1_ORDER).toBe(true);
    }
  });

  test('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newXmtpPrivateKey());
    expect(seen.size).toBe(200);
  });

  test('prepareAccount hands the key back once, and stores the same one', async () => {
    const prepared = await prepareAccount({ station: 'xmtp' });
    expect(prepared.secret?.value).toBe(prepared.config.privateKey as string);
    expect(prepared.identity).toEqual({});
  });
});

describe('bot token shape is checked before any network call', () => {
  const reject = async (station: 'discord' | 'telegram', token: unknown) => {
    const err = await prepareAccount({ station, token }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StationAttachError);
    return err as StationAttachError;
  };

  test('a missing token never reaches the provider', async () => {
    for (const token of [undefined, '', '   ', null, 42, {}]) {
      const err = await reject('telegram', token);
      expect(err.status).toBe(400);
      expect(err.message).toContain('required');
    }
  });

  test('a token with spaces, newlines or slashes is refused locally', async () => {
    for (const token of [
      'has space here',
      'line\nbreak-in-token',
      '../../etc/passwd',
      'short',
      `${'x'.repeat(257)}`,
    ]) {
      const err = await reject('discord', token);
      expect(err.status).toBe(400);
      expect(err.message).toContain('does not look like');
    }
  });

  test('the refusal message never repeats the token back', async () => {
    const err = await reject('discord', 'a token with spaces');
    expect(err.message).not.toContain('a token with spaces');
  });
});

describe('account id shape', () => {
  test('accepts the ids Metro generates', () => {
    expect(parseAccountId('a1-0a1b2c3d')).toBe('a1-0a1b2c3d');
    expect(parseAccountId('t0')).toBe('t0');
  });

  test('refuses anything that could travel outside its own segment', () => {
    for (const bad of ['', '..', 'a/b', 'A1-XX', 'a 1', '-lead', `${'a'.repeat(65)}`])
      expect(parseAccountId(bad)).toBeNull();
  });
});
