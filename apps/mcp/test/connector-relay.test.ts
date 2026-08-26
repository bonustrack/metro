import { describe, expect, test } from 'bun:test';
import { fixedTarget, staleUsable } from '../src/db/connector-relay.ts';

const URL = 'https://mcp.snapshot.box/';

describe('credential-less connectors ride the relay bare', () => {
  test('a no-auth row forwards with no injected headers, never a 424', () => {
    expect(fixedTarget(URL, { kind: 'none' }, false)).toEqual({
      kind: 'ok',
      url: URL,
      headers: {},
    });
  });

  test('a header row forwards its stored header', () => {
    expect(
      fixedTarget(URL, { kind: 'header', name: 'x-api-key', value: 'k1' }, false),
    ).toEqual({ kind: 'ok', url: URL, headers: { 'x-api-key': 'k1' } });
  });

  test('after an upstream refusal there is nothing to improve, so signin', () => {
    expect(fixedTarget(URL, { kind: 'none' }, true)).toEqual({ kind: 'signin' });
    expect(
      fixedTarget(URL, { kind: 'header', name: 'x-api-key', value: 'k1' }, true),
    ).toEqual({ kind: 'signin' });
  });
});

describe('stale-token degradation', () => {
  const base = {
    kind: 'oauth' as const,
    accessToken: 'at',
    issuer: 'https://as.example.com',
    tokenEndpoint: 'https://as.example.com/token',
    clientId: 'c',
  };

  test('a token with time left is still usable when a refresh fails', () => {
    expect(staleUsable({ ...base, expiresAt: 2_000 }, 1_000)).toBe(true);
    expect(staleUsable({ ...base, expiresAt: 999 }, 1_000)).toBe(false);
    expect(staleUsable(base, 1_000)).toBe(true);
  });
});
