import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHABLE_STATIONS,
  isAttachStation,
  newXmtpPrivateKey,
  prepareAccount,
  StationAttachError,
} from '../src/stations/attach.ts';
import {
  XmtpAttachError,
  type VerifyXmtpKey,
} from '../src/stations/attach-xmtp.ts';
import { isStationName, parseAccountId } from '../src/db/account-attach.ts';

const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

const INBOX = 'c'.repeat(64);

const opened = (
  seen: { key: string; dbPath: string }[],
  resolved = '/tmp/metro-fake-inbox.db3',
): VerifyXmtpKey => {
  return (privateKey, dbPath) => {
    seen.push({ key: privateKey, dbPath });
    return Promise.resolve({
      inboxId: INBOX,
      address: '0x4a76C41C3B3c50F2E75aCFb77C36e35D603d628f',
      installationId: 'd'.repeat(64),
      dbPath: resolved,
    });
  };
};

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
    const seen: { key: string; dbPath: string }[] = [];
    const prepared = await prepareAccount({ station: 'xmtp' }, opened(seen));
    expect(prepared.secret?.value).toBe(prepared.config.privateKey as string);
    expect(seen[0]?.key).toBe(prepared.config.privateKey as string);
  });
});

describe('a generated xmtp key is only stored once XMTP opened an inbox with it', () => {
  test('the identity carries the inbox XMTP actually opened', async () => {
    const seen: { key: string; dbPath: string }[] = [];
    const prepared = await prepareAccount({ station: 'xmtp' }, opened(seen));
    expect(prepared.identity.inboxId).toBe(INBOX);
    expect(prepared.identity.address).toBe(
      '0x4a76C41C3B3c50F2E75aCFb77C36e35D603d628f',
    );
    expect(prepared.secret?.note).toContain(INBOX);
  });

  test('the row records the database the verified installation lives in', async () => {
    const seen: { key: string; dbPath: string }[] = [];
    const prepared = await prepareAccount({ station: 'xmtp' }, opened(seen));
    expect(prepared.config.dbPath).toMatch(
      /^~\/\.metro\/xmtp-production-[0-9a-f]{16}\.db3$/,
    );
    expect(seen[0]?.dbPath).toBe(prepared.config.dbPath as string);
  });

  test('two attaches never share a database, so neither reuses the other installation', async () => {
    const seen: { key: string; dbPath: string }[] = [];
    await prepareAccount({ station: 'xmtp' }, opened(seen));
    await prepareAccount({ station: 'xmtp' }, opened(seen));
    expect(seen[0]?.dbPath).not.toBe(seen[1]?.dbPath);
    expect(seen[0]?.key).not.toBe(seen[1]?.key);
  });

  test('a key XMTP would not open an inbox for yields no account at all', async () => {
    const err = await prepareAccount({ station: 'xmtp' }, () =>
      Promise.reject(new XmtpAttachError('XMTP did not register an inbox')),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StationAttachError);
    expect((err as StationAttachError).status).toBe(400);
    expect((err as StationAttachError).message).toContain('did not register');
  });

  test('an unexpected failure in the check is still a refusal, not an account', async () => {
    const err = await prepareAccount({ station: 'xmtp' }, () =>
      Promise.reject(new Error('bun: command not found')),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StationAttachError);
    expect((err as StationAttachError).message).toContain(
      'could not open an XMTP inbox',
    );
    expect((err as StationAttachError).message).not.toContain('command not found');
  });

  test('discarding removes the database the check created', async () => {
    const resolved = join(
      mkdtempSync(join(tmpdir(), 'metro-xmtp-prepare-')),
      'inbox.db3',
    );
    writeFileSync(resolved, 'x');
    const prepared = await prepareAccount({ station: 'xmtp' }, opened([], resolved));
    prepared.discard?.();
    expect(existsSync(resolved)).toBe(false);
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
