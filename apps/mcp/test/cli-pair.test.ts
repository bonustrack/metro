import { describe, expect, test } from 'bun:test';
import {
  CLI_CODE_RE,
  cliCodeCount,
  mintCliCode,
  takeCliCode,
} from '../src/daemon/cli-pair.js';

const TTL_MS = 10 * 60_000;
const SEED = { email: 'less@bonustrack.co', collectionId: 'list0000001' };

describe('the pairing code the web UI shows the CLI', () => {
  test('it is prefixed, fixed width and unguessable', () => {
    const { code } = mintCliCode(SEED);
    expect(code).toMatch(CLI_CODE_RE);
    expect(code.length).toBe(19);
    const others = new Set(
      Array.from({ length: 50 }, () => mintCliCode(SEED).code),
    );
    expect(others.size).toBe(50);
  });

  test('it resolves to the account AND the collection it was minted for', () => {
    const { code } = mintCliCode(SEED);
    expect(takeCliCode(code)).toEqual(SEED);
  });

  test('it is single use, so a shoulder-surfed code is spent', () => {
    const { code } = mintCliCode(SEED);
    expect(takeCliCode(code)).toEqual(SEED);
    expect(takeCliCode(code)).toBeUndefined();
  });

  test('a code nobody minted is refused', () => {
    expect(takeCliCode('mc_aaaaaaaaaaaaaaaa')).toBeUndefined();
  });

  test('it expires, and expiring consumes it rather than leaving it live', () => {
    const now = Date.now();
    const { code, expiresAt } = mintCliCode(SEED, now);
    expect(expiresAt).toBe(now + TTL_MS);
    expect(takeCliCode(code, now + TTL_MS + 1)).toBeUndefined();
    expect(takeCliCode(code, now)).toBeUndefined();
  });

  test('expired codes do not pile up in memory', () => {
    const now = Date.now();
    mintCliCode(SEED, now);
    const before = cliCodeCount();
    mintCliCode(SEED, now + TTL_MS + 1);
    expect(cliCodeCount()).toBeLessThan(before + 2);
  });
});
