import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discardXmtpDb,
  newXmtpDbPath,
  verifyXmtpKeyOutOfProcess,
  withoutKey,
  XmtpAttachError,
} from '../src/stations/attach-xmtp.ts';

const NOT_A_KEY = '0xnot-a-real-xmtp-key';

describe('the database a generated xmtp identity will live in', () => {
  test('always lands under the metro home directory', () => {
    for (let i = 0; i < 20; i++)
      expect(newXmtpDbPath()).toMatch(/^~\/\.metro\/xmtp-production-[0-9a-f]{16}\.db3$/);
  });

  test('never repeats, so two attaches cannot share one installation', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newXmtpDbPath());
    expect(seen.size).toBe(200);
  });

  test('discarding removes the database and its sqlite sidecars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-xmtp-discard-'));
    const db = join(dir, 'inbox.db3');
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(`${db}${suffix}`, 'x');
    discardXmtpDb(db);
    for (const suffix of ['', '-wal', '-shm'])
      expect(existsSync(`${db}${suffix}`)).toBe(false);
  });

  test('discarding a database that was never created is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-xmtp-discard-'));
    expect(() => {
      discardXmtpDb(join(dir, 'never-made.db3'));
    }).not.toThrow();
  });
});

describe('a refusal never carries the key it was checking', () => {
  test('the key is redacted out of whatever the checker said', () => {
    const message = withoutKey(`XMTP rejected ${NOT_A_KEY} twice`, NOT_A_KEY);
    expect(message).not.toContain(NOT_A_KEY);
    expect(message).toContain('[redacted]');
  });

  test('a message that never mentioned the key is untouched', () => {
    expect(withoutKey('XMTP was unreachable', NOT_A_KEY)).toBe(
      'XMTP was unreachable',
    );
  });
});

describe('the out-of-process inbox check', () => {
  test('a key XMTP cannot use is refused and writes no database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-xmtp-verify-'));
    const db = join(dir, 'inbox.db3');
    const err = await verifyXmtpKeyOutOfProcess(NOT_A_KEY, db).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(XmtpAttachError);
    expect((err as Error).message).toContain('not a usable XMTP private key');
    expect((err as Error).message).not.toContain(NOT_A_KEY);
    expect(existsSync(db)).toBe(false);
  }, 60_000);
});
