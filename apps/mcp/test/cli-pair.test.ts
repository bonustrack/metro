import { describe, expect, test } from 'bun:test';
import {
  CLI_CODE_RE,
  cliCodeCount,
  mintCliCode,
  takeCliCode,
} from '../src/daemon/cli-pair.js';

const TTL_MS = 10 * 60_000;

describe('the pairing code the web UI shows the CLI', () => {
  test('it is prefixed, fixed width and unguessable', () => {
    const { code } = mintCliCode('less@bonustrack.co');
    expect(code).toMatch(CLI_CODE_RE);
    expect(code.length).toBe(19);
    const others = new Set(
      Array.from({ length: 50 }, () => mintCliCode('less@bonustrack.co').code),
    );
    expect(others.size).toBe(50);
  });

  test('it resolves to the account that minted it', () => {
    const { code } = mintCliCode('less@bonustrack.co');
    expect(takeCliCode(code)).toBe('less@bonustrack.co');
  });

  test('it is single use, so a shoulder-surfed code is spent', () => {
    const { code } = mintCliCode('less@bonustrack.co');
    expect(takeCliCode(code)).toBe('less@bonustrack.co');
    expect(takeCliCode(code)).toBeUndefined();
  });

  test('a code nobody minted is refused', () => {
    expect(takeCliCode('mc_aaaaaaaaaaaaaaaa')).toBeUndefined();
  });

  test('it expires, and expiring consumes it rather than leaving it live', () => {
    const now = Date.now();
    const { code, expiresAt } = mintCliCode('less@bonustrack.co', now);
    expect(expiresAt).toBe(now + TTL_MS);
    expect(takeCliCode(code, now + TTL_MS + 1)).toBeUndefined();
    expect(takeCliCode(code, now)).toBeUndefined();
  });

  test('expired codes do not pile up in memory', () => {
    const now = Date.now();
    mintCliCode('less@bonustrack.co', now);
    const before = cliCodeCount();
    mintCliCode('less@bonustrack.co', now + TTL_MS + 1);
    expect(cliCodeCount()).toBeLessThan(before + 2);
  });
});
