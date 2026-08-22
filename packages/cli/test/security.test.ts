import { describe, expect, test } from 'bun:test';
import { sessionFrom } from '../src/login.ts';
import { carriesSecretsSafely } from '../src/api.ts';

describe('the sign-in listener only accepts the browser it opened', () => {
  const NONCE = 'the-nonce-this-run-minted';

  test('the page it served, carrying the nonce, is accepted', () => {
    expect(sessionFrom(`session=jwt-value&s=${NONCE}`, NONCE)).toBe('jwt-value');
  });

  test('another page posting a session without the nonce is refused', () => {
    expect(sessionFrom('session=attacker-jwt', NONCE)).toBe('');
  });

  test('a wrong nonce is refused, so guessing the port is not enough', () => {
    expect(sessionFrom('session=attacker-jwt&s=wrong', NONCE)).toBe('');
  });

  test('the nonce alone, with no session, yields nothing', () => {
    expect(sessionFrom(`s=${NONCE}`, NONCE)).toBe('');
  });

  test('an empty body is not a sign-in', () => {
    expect(sessionFrom('', NONCE)).toBe('');
  });
});

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
