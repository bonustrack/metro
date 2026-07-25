import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import {
  authenticate,
  extractToken,
  type AuthConfig,
} from '../src/mcp/request-identity.ts';
import { signSession } from '../src/daemon/session.ts';

const SECRET = 'session-signing-secret';
const req = (url: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ url, headers }) as unknown as IncomingMessage;

const cfg = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  apiKey: 'secret-key',
  sessionSecret: SECRET,
  ...over,
});

describe('extractToken', () => {
  test('reads ?token= query param', () => {
    expect(extractToken(req('/mcp?token=abc'))).toBe('abc');
  });
  test('reads Authorization Bearer header', () => {
    expect(extractToken(req('/mcp', { authorization: 'Bearer xyz' }))).toBe('xyz');
  });
  test('undefined when neither present', () => {
    expect(extractToken(req('/mcp'))).toBeUndefined();
  });
});

describe('authenticate', () => {
  test('open access when nothing is configured', () => {
    expect(authenticate(req('/mcp'), cfg({ apiKey: '', sessionSecret: '' }))).toEqual({
      kind: 'key',
    });
  });

  test('accepts the API key as a full-access key identity (query)', () => {
    expect(authenticate(req('/mcp?token=secret-key'), cfg())).toEqual({ kind: 'key' });
  });

  test('accepts the API key via Bearer header', () => {
    expect(
      authenticate(req('/mcp', { authorization: 'Bearer secret-key' }), cfg()),
    ).toEqual({ kind: 'key' });
  });

  test('rejects a wrong opaque token', () => {
    expect(authenticate(req('/mcp?token=nope'), cfg())).toBeNull();
  });

  test('rejects a missing token when configured', () => {
    expect(authenticate(req('/mcp'), cfg())).toBeNull();
  });

  test('accepts a valid daemon session JWT and scopes to its agents', () => {
    const token = signSession({ email: 'fabien@bonustrack.co', agents: ['tony'] }, SECRET);
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toEqual({
      kind: 'google',
      email: 'fabien@bonustrack.co',
      agents: ['tony'],
    });
  });

  test('rejects a session signed with a different secret', () => {
    const token = signSession({ email: 'x@y.z', agents: ['tony'] }, 'other-secret');
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toBeNull();
  });

  test('rejects an expired session', () => {
    const token = signSession({ email: 'x@y.z', agents: ['tony'] }, SECRET, {
      ttlSec: -10,
    });
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toBeNull();
  });

  test('rejects a tampered session payload', () => {
    const token = signSession({ email: 'x@y.z', agents: ['tony'] }, SECRET);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ typ: 'session', sub: 'x@y.z', agents: ['admin'], exp: 9_999_999_999 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(authenticate(req(`/mcp?token=${h}.${forged}.${s}`), cfg())).toBeNull();
  });

  test('does not treat the API key as a JWT', () => {
    expect(authenticate(req('/mcp?token=secret-key'), cfg())).toEqual({ kind: 'key' });
  });
});
