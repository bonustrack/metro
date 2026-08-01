import { afterEach, describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import {
  allowedAgents,
  authenticate,
  extractToken,
  type AuthConfig,
} from '../src/mcp/request-identity.ts';
import { signSession } from '../src/daemon/session.ts';
import { setKeyMap } from '../src/db/key-map.ts';

afterEach(() => setKeyMap([]));

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

  test('accepts a per-agent DB key and scopes the identity to that agent', () => {
    setKeyMap([{ key: 'mk_selfserve', agent: 'newbie' }]);
    expect(authenticate(req('/mcp?token=mk_selfserve'), cfg())).toEqual({
      kind: 'agent',
      agent: 'newbie',
    });
  });

  test('a per-agent key also works as a Bearer header', () => {
    setKeyMap([{ key: 'mk_selfserve', agent: 'newbie' }]);
    expect(
      authenticate(req('/mcp', { authorization: 'Bearer mk_selfserve' }), cfg()),
    ).toEqual({ kind: 'agent', agent: 'newbie' });
  });

  test('the full-access env key still wins over the per-agent key map', () => {
    setKeyMap([{ key: 'secret-key', agent: 'newbie' }]);
    expect(authenticate(req('/mcp?token=secret-key'), cfg())).toEqual({ kind: 'key' });
  });

  test('a revoked (unmapped) agent key is rejected', () => {
    setKeyMap([{ key: 'mk_live', agent: 'newbie' }]);
    expect(authenticate(req('/mcp?token=mk_revoked'), cfg())).toBeNull();
  });
});

describe('allowedAgents', () => {
  test('the full-access key identity is unscoped', () => {
    expect(allowedAgents({ kind: 'key' })).toBeUndefined();
    expect(allowedAgents(undefined)).toBeUndefined();
  });

  test('an agent key is scoped to exactly its own agent', () => {
    expect(allowedAgents({ kind: 'agent', agent: 'newbie' })).toEqual(new Set(['newbie']));
  });

  test('a google session is scoped to its granted agents', () => {
    expect(
      allowedAgents({ kind: 'google', email: 'a@b.co', agents: ['tony', 'wan'] }),
    ).toEqual(new Set(['tony', 'wan']));
  });

  test('a google session with no agents is scoped to nothing (not everything)', () => {
    const scope = allowedAgents({ kind: 'google', email: 'a@b.co', agents: [] });
    expect(scope).toEqual(new Set());
    expect(scope?.size).toBe(0);
  });
});
