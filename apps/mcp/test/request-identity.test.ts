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
  test('nothing configured is closed, not open', () => {
    expect(authenticate(req('/mcp'), cfg({ sessionSecret: '' }))).toBeNull();
    expect(authenticate(req('/mcp?token=anything'), cfg({ sessionSecret: '' }))).toBeNull();
  });

  test('rejects a wrong opaque token', () => {
    expect(authenticate(req('/mcp?token=nope'), cfg())).toBeNull();
  });

  test('rejects a missing token when configured', () => {
    expect(authenticate(req('/mcp'), cfg())).toBeNull();
  });

  test('accepts a valid daemon session JWT and scopes to its agents', () => {
    const token = signSession({ email: 'fabien@bonustrack.co', agentIds: ['agent000001'] }, SECRET);
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toEqual({
      kind: 'google',
      email: 'fabien@bonustrack.co',
      agentIds: ['agent000001'],
    });
  });

  test('rejects a session signed with a different secret', () => {
    const token = signSession({ email: 'x@y.z', agentIds: ['agent000001'] }, 'other-secret');
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toBeNull();
  });

  test('rejects an expired session', () => {
    const token = signSession({ email: 'x@y.z', agentIds: ['agent000001'] }, SECRET, {
      ttlSec: -10,
    });
    expect(authenticate(req(`/mcp?token=${token}`), cfg())).toBeNull();
  });

  test('rejects a tampered session payload', () => {
    const token = signSession({ email: 'x@y.z', agentIds: ['agent000001'] }, SECRET);
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

  test('does not treat an opaque agent key as a JWT', () => {
    setKeyMap([{ key: 'secret-key', agentId: 'agent000003' }]);
    expect(authenticate(req('/mcp?token=secret-key'), cfg())).toEqual({
      kind: 'agent',
      agentId: 'agent000003',
    });
  });

  test('accepts a per-agent DB key and scopes the identity to that agent id', () => {
    setKeyMap([{ key: 'mk_selfserve', agentId: 'agent000012' }]);
    expect(authenticate(req('/mcp?token=mk_selfserve'), cfg())).toEqual({
      kind: 'agent',
      agentId: 'agent000012',
    });
  });

  test('a per-agent key also works as a Bearer header', () => {
    setKeyMap([{ key: 'mk_selfserve', agentId: 'agent000012' }]);
    expect(
      authenticate(req('/mcp', { authorization: 'Bearer mk_selfserve' }), cfg()),
    ).toEqual({ kind: 'agent', agentId: 'agent000012' });
  });

  test('same-named agents get distinct identities from their own keys', () => {
    setKeyMap([
      { key: 'mk_ada_tony', agentId: 'agent000007' },
      { key: 'mk_bob_tony', agentId: 'agent000008' },
    ]);
    expect(authenticate(req('/mcp?token=mk_ada_tony'), cfg())).toEqual({
      kind: 'agent',
      agentId: 'agent000007',
    });
    expect(authenticate(req('/mcp?token=mk_bob_tony'), cfg())).toEqual({
      kind: 'agent',
      agentId: 'agent000008',
    });
  });

  test('there is no unscoped identity left: every key resolves to one agent', () => {
    setKeyMap([{ key: 'secret-key', agentId: 'agent000012' }]);
    const identity = authenticate(req('/mcp?token=secret-key'), cfg());
    expect(identity).toEqual({ kind: 'agent', agentId: 'agent000012' });
    expect(allowedAgents(identity ?? undefined)).toEqual(new Set(['agent000012']));
  });

  test('a revoked (unmapped) agent key is rejected', () => {
    setKeyMap([{ key: 'mk_live', agentId: 'agent000012' }]);
    expect(authenticate(req('/mcp?token=mk_revoked'), cfg())).toBeNull();
  });
});

describe('allowedAgents', () => {
  test('no identity is scoped to nothing, never to everything', () => {
    expect(allowedAgents(undefined)).toEqual(new Set());
  });

  test('an agent key is scoped to exactly its own agent id', () => {
    expect(allowedAgents({ kind: 'agent', agentId: 'agent000012' })).toEqual(new Set(['agent000012']));
  });

  test('a google session is scoped to its granted agent ids', () => {
    expect(
      allowedAgents({ kind: 'google', email: 'a@b.co', agentIds: ['agent000001', 'agent000002'] }),
    ).toEqual(new Set(['agent000001', 'agent000002']));
  });

  test('a google session with no agents is scoped to nothing (not everything)', () => {
    const scope = allowedAgents({ kind: 'google', email: 'a@b.co', agentIds: [] });
    expect(scope).toEqual(new Set());
    expect(scope?.size).toBe(0);
  });
});
