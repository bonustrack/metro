import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import {
  authenticate,
  extractToken,
  type AuthConfig,
} from '../src/mcp/request-identity.ts';
import { parseEmailAgentMap } from '../src/daemon/google-auth.ts';

const req = (url: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ url, headers }) as unknown as IncomingMessage;

const baseCfg = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  apiKey: 'secret-key',
  googleClientId: 'client-123',
  emailAgents: parseEmailAgentMap('{"fabien@bonustrack.co":["tony"]}'),
  verifyToken: (token) =>
    token === 'good.jwt.sig'
      ? Promise.resolve({ email: 'fabien@bonustrack.co' })
      : Promise.reject(new Error('bad token')),
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
  test('open access when nothing is configured', async () => {
    const id = await authenticate(req('/mcp'), baseCfg({ apiKey: '', googleClientId: '' }));
    expect(id).toEqual({ kind: 'key' });
  });

  test('accepts the API key as a full-access key identity', async () => {
    const id = await authenticate(req('/mcp?token=secret-key'), baseCfg());
    expect(id).toEqual({ kind: 'key' });
  });

  test('accepts the API key via Bearer header', async () => {
    const id = await authenticate(
      req('/mcp', { authorization: 'Bearer secret-key' }),
      baseCfg(),
    );
    expect(id).toEqual({ kind: 'key' });
  });

  test('rejects a wrong opaque token', async () => {
    expect(await authenticate(req('/mcp?token=nope'), baseCfg())).toBeNull();
  });

  test('rejects a missing token when configured', async () => {
    expect(await authenticate(req('/mcp'), baseCfg())).toBeNull();
  });

  test('accepts a valid Google token mapped to agents', async () => {
    const id = await authenticate(req('/mcp?token=good.jwt.sig'), baseCfg());
    expect(id).toEqual({ kind: 'google', email: 'fabien@bonustrack.co', agents: ['tony'] });
  });

  test('rejects a valid Google token whose email is not mapped', async () => {
    const cfg = baseCfg({
      verifyToken: () => Promise.resolve({ email: 'stranger@gmail.com' }),
    });
    expect(await authenticate(req('/mcp?token=good.jwt.sig'), cfg)).toBeNull();
  });

  test('rejects a Google token that fails verification', async () => {
    expect(await authenticate(req('/mcp?token=bad.jwt.sig'), baseCfg())).toBeNull();
  });

  test('does not treat the API key as a JWT even if google is configured', async () => {
    const cfg = baseCfg({
      verifyToken: () => Promise.reject(new Error('should not be called')),
    });
    const id = await authenticate(req('/mcp?token=secret-key'), cfg);
    expect(id).toEqual({ kind: 'key' });
  });
});
