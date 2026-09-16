import { describe, expect, test } from 'bun:test';
import { whyUnreachable } from '../src/connectors/reach.ts';

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe('why a connector could not be reached', () => {
  test('the real reason comes through, with a plain-words hint for the common codes', () => {
    expect(whyUnreachable(withCode('getaddrinfo ENOTFOUND mcp-vault.piston.box', 'ENOTFOUND'))).toBe(
      'getaddrinfo ENOTFOUND mcp-vault.piston.box (the name does not resolve)',
    );
    expect(whyUnreachable(withCode('certificate has expired', 'CERT_HAS_EXPIRED'))).toBe('certificate has expired (its certificate has expired)');
    expect(whyUnreachable(withCode('connect ECONNREFUSED 127.0.0.1:9', 'ECONNREFUSED'))).toBe(
      'connect ECONNREFUSED 127.0.0.1:9 (nothing is listening there)',
    );
  });

  test("Node's fetch wraps the reason in a cause, and the cause is what is shown", () => {
    const wrapped = new Error('fetch failed', { cause: withCode('getaddrinfo ENOTFOUND x.example', 'ENOTFOUND') });
    expect(whyUnreachable(wrapped)).toBe('getaddrinfo ENOTFOUND x.example (the name does not resolve)');
    expect(whyUnreachable(new Error('fetch failed'))).toBe('no answer');
  });

  test('an unfamiliar error is shown as it is, and a non-error is stringified', () => {
    expect(whyUnreachable(new Error('socket hang up'))).toBe('socket hang up');
    expect(whyUnreachable('boom')).toBe('boom');
  });
});
