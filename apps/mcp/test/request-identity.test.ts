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
    const token = signSession({ email: 'fabien@bonustrack.co', agentIds: [1] }, SECRET);
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toEqual({
      kind: 'google',
      email: 'fabien@bonustrack.co',
      agentIds: [1],
    });
  });

  test('rejects a session signed with a different secret', () => {
    const token = signSession({ email: 'x@y.z', agentIds: [1] }, 'other-secret');
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toBeNull();
  });

  test('rejects an expired session', () => {
    const token = signSession({ email: 'x@y.z', agentIds: [1] }, SECRET, {
      ttlSec: -10,
    });
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toBeNull();
  });

  test('rejects a tampered session payload', () => {
    const token = signSession({ email: 'x@y.z', agentIds: [1] }, SECRET);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ typ: 'session', sub: 'x@y.z', agent_ids: [99], exp: 9_999_999_999 }),
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

  test('accepts a per-agent DB key and scopes the identity to that agent id', () => {
    setKeyMap([{ key: 'mk_selfserve', agentId: 12 }]);
    expect(authenticate(req('/mcp?token=mk_selfserve'), cfg())).toEqual({
      kind: 'agent',
      agentId: 12,
    });
  });

  test('a per-agent key also works as a Bearer header', () => {
    setKeyMap([{ key: 'mk_selfserve', agentId: 12 }]);
    expect(
      authenticate(req('/mcp', { authorization: 'Bearer mk_selfserve' }), cfg()),
    ).toEqual({ kind: 'agent', agentId: 12 });
  });

  test('same-named agents get distinct identities from their own keys', () => {
    setKeyMap([
      { key: 'mk_ada_tony', agentId: 7 },
      { key: 'mk_bob_tony', agentId: 8 },
    ]);
    expect(authenticate(req('/mcp?token=mk_ada_tony'), cfg())).toEqual({
      kind: 'agent',
      agentId: 7,
    });
    expect(authenticate(req('/mcp?token=mk_bob_tony'), cfg())).toEqual({
      kind: 'agent',
      agentId: 8,
    });
  });

  test('the full-access env key still wins over the per-agent key map', () => {
    setKeyMap([{ key: 'secret-key', agentId: 12 }]);
    expect(authenticate(req('/mcp?token=secret-key'), cfg())).toEqual({ kind: 'key' });
  });

  test('a revoked (unmapped) agent key is rejected', () => {
    setKeyMap([{ key: 'mk_live', agentId: 12 }]);
    expect(authenticate(req('/mcp?token=mk_revoked'), cfg())).toBeNull();
  });
});

describe('allowedAgents', () => {
  test('the full-access key identity is unscoped', () => {
    expect(allowedAgents({ kind: 'key' })).toBeUndefined();
    expect(allowedAgents(undefined)).toBeUndefined();
  });

  test('an agent key is scoped to exactly its own agent id', () => {
    expect(allowedAgents({ kind: 'agent', agentId: 12 })).toEqual(new Set([12]));
  });

  test('a google session is scoped to its granted agent ids', () => {
    expect(
      allowedAgents({ kind: 'google', email: 'a@b.co', agentIds: [1, 2] }),
    ).toEqual(new Set([1, 2]));
  });

  test('a google session with no agents is scoped to nothing (not everything)', () => {
    const scope = allowedAgents({ kind: 'google', email: 'a@b.co', agentIds: [] });
    expect(scope).toEqual(new Set());
    expect(scope?.size).toBe(0);
  });
});
