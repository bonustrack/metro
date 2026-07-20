import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  allowlistForLine,
  senderMatchesAllowlist,
  setAllowlistMap,
} from '../src/db/agent-map.ts';

describe('per-account allowlist', () => {
  beforeEach(() => setAllowlistMap({}));
  afterAll(() => setAllowlistMap({}));

  test('no allowlist configured for the account allows all senders', () => {
    expect(allowlistForLine('metro://discord/d0/chan1')).toBeUndefined();
  });

  test('resolves the allowlist per account from the line', () => {
    setAllowlistMap({ 'xmtp/x0': ['abc123'] });
    expect(allowlistForLine('metro://xmtp/x0/conv1')).toEqual(['abc123']);
    expect(allowlistForLine('metro://xmtp/x1/conv1')).toBeUndefined();
  });

  test('empty allowlist or "*" allows all senders', () => {
    expect(senderMatchesAllowlist([], 'metro://xmtp/x0/user/abc')).toBe(true);
    expect(senderMatchesAllowlist(['*'], 'metro://xmtp/x0/user/abc')).toBe(true);
  });

  test('matches the sender id tail case-insensitively', () => {
    expect(senderMatchesAllowlist(['ABC'], 'metro://xmtp/x0/user/abc')).toBe(
      true,
    );
    expect(senderMatchesAllowlist(['abc'], 'metro://xmtp/x0/user/xyz')).toBe(
      false,
    );
  });
});
