import { describe, expect, test } from 'bun:test';
import { carriesSecretsSafely } from '../src/api.ts';

describe('the session token never goes out in the clear', () => {
  test('https is fine wherever it points', () => {
    expect(carriesSecretsSafely('https://mcp.metro.box')).toBe(true);
  });

  test('plain http to a remote host is refused', () => {
    expect(carriesSecretsSafely('http://mcp.metro.box')).toBe(false);
    expect(carriesSecretsSafely('http://192.168.1.10:8420')).toBe(false);
  });

  test('plain http to loopback is allowed, for a local daemon', () => {
    expect(carriesSecretsSafely('http://localhost:8420')).toBe(true);
    expect(carriesSecretsSafely('http://127.0.0.1:8420')).toBe(true);
  });

  test('a host merely containing localhost does not count', () => {
    expect(carriesSecretsSafely('http://localhost.evil.com')).toBe(false);
    expect(carriesSecretsSafely('http://notlocalhost')).toBe(false);
  });

  test('anything unparseable is refused rather than assumed safe', () => {
    expect(carriesSecretsSafely('')).toBe(false);
    expect(carriesSecretsSafely('mcp.metro.box')).toBe(false);
  });
});
