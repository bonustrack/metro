import { afterEach, describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { allowedAgents, authenticate, extractToken } from '../src/mcp/request-identity.ts';
import { setKeyMap } from '../src/agents/keys.ts';

afterEach(() => setKeyMap([]));

const req = (url: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ url, headers }) as unknown as IncomingMessage;

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
    expect(authenticate(req('/mcp'))).toBeNull();
    expect(authenticate(req('/mcp?token=anything'))).toBeNull();
  });

  test('a signed identity header is not a key: it never opens /mcp', () => {
    setKeyMap([{ key: 'mk_live', agentId: 'agent000012' }]);
    expect(authenticate(req('/mcp', { authorization: 'Metro 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 1 0xabc' }))).toBeNull();
  });

  test('accepts a per-agent key and scopes the identity to that agent id', () => {
    setKeyMap([{ key: 'mk_selfserve', agentId: 'agent000012' }]);
    expect(authenticate(req('/mcp?token=mk_selfserve'))).toEqual({ kind: 'agent', agentId: 'agent000012' });
    expect(authenticate(req('/mcp', { authorization: 'Bearer mk_selfserve' }))).toEqual({ kind: 'agent', agentId: 'agent000012' });
  });

  test('same-named agents get distinct identities from their own keys', () => {
    setKeyMap([
      { key: 'mk_ada_tony', agentId: 'agent000007' },
      { key: 'mk_bob_tony', agentId: 'agent000008' },
    ]);
    expect(authenticate(req('/mcp?token=mk_ada_tony'))).toEqual({ kind: 'agent', agentId: 'agent000007' });
    expect(authenticate(req('/mcp?token=mk_bob_tony'))).toEqual({ kind: 'agent', agentId: 'agent000008' });
  });

  test('there is no unscoped identity left: every key resolves to one agent', () => {
    setKeyMap([{ key: 'secret-key', agentId: 'agent000012' }]);
    const identity = authenticate(req('/mcp?token=secret-key'));
    expect(identity).toEqual({ kind: 'agent', agentId: 'agent000012' });
    expect(allowedAgents(identity ?? undefined)).toEqual(new Set(['agent000012']));
  });

  test('the key works only on this machine, never through the Tailscale serve or Funnel address', () => {
    setKeyMap([{ key: 'mk_live', agentId: 'agent000012' }]);
    expect(authenticate(req('/mcp', { authorization: 'Bearer mk_live' }))).toEqual({ kind: 'agent', agentId: 'agent000012' });
    for (const proxied of [{ 'x-forwarded-for': '100.64.0.9' }, { 'x-forwarded-host': 'metro-x.ts.net' }, { 'tailscale-funnel-request': '?1' }])
      expect(authenticate(req('/mcp', { authorization: 'Bearer mk_live', ...proxied }))).toBeNull();
    expect(authenticate(req('/api/tail?token=mk_live', { 'x-forwarded-for': '203.0.113.7' }))).toBeNull();
  });

  test('a revoked (unmapped) agent key is rejected', () => {
    setKeyMap([{ key: 'mk_live', agentId: 'agent000012' }]);
    expect(authenticate(req('/mcp?token=mk_revoked'))).toBeNull();
  });
});

describe('allowedAgents', () => {
  test('no identity is scoped to nothing, never to everything', () => {
    expect(allowedAgents(undefined)).toEqual(new Set());
  });

  test('an agent key is scoped to exactly its own agent id', () => {
    expect(allowedAgents({ kind: 'agent', agentId: 'agent000012' })).toEqual(new Set(['agent000012']));
  });
});
