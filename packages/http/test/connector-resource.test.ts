import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { discoverPublicOAuth, OAuthResourceRequired } from '../src/connector-resource.js';
import { parsePublicConnectorUrl, publicOAuthResource } from '../src/connector-public-url.js';

const ORIGIN = 'https://mcp.example.com';
const ISSUER = 'https://identity.example.com/tenant';
const PRM = `${ORIGIN}/.well-known/oauth-protected-resource`;
const AS = 'https://identity.example.com/.well-known/oauth-authorization-server/tenant';
const authorization = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register`, code_challenge_methods_supported: ['S256'] };
const resource = (audience = `${ORIGIN}/mcp-server/http`) => ({ resource: audience, authorization_servers: [ISSUER], scopes_supported: ['read', 'write'] });

function fixture(values: Record<string, unknown>): { send: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    send: (url, init) => {
      calls.push(url);
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      const value = values[url];
      return Promise.resolve(value instanceof Response ? value : value === undefined ? new Response('', { status: 404 }) : Response.json(value));
    },
  };
}

describe('public OAuth identity is not the confidential MCP transport', () => {
  test.each(['/mcp-server/http', '/providers/tenant-42/nested/mcp', '/providers/%E2%9C%93/%2F/http'])('uses published root metadata for %s without sending the saved path or query to discovery', async (path) => {
    const audience = `${ORIGIN}${path}`;
    const target = `${audience}?api_key=QUERY_SECRET&tenant=PRIVATE_TENANT`;
    const { send, calls } = fixture({ [PRM]: resource(audience), [AS]: authorization });
    const result = await discoverPublicOAuth(target, undefined, send);
    expect(result.resource).toBe(audience);
    expect(result.server).toMatchObject({ issuer: `${ISSUER}`, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, scopes: ['read', 'write'] });
    expect(calls).toEqual([PRM, AS]);
    expect(JSON.stringify({ result, calls })).not.toContain('QUERY_SECRET');
    expect(JSON.stringify({ result, calls })).not.toContain('PRIVATE_TENANT');
  });

  test('only an independently supplied public audience enables path-scoped discovery', async () => {
    const audience = `${ORIGIN}/public/tenant`;
    const target = `${audience}/private-capability/transport?token=SECRET`;
    const scoped = `${PRM}/public/tenant`;
    const { send, calls } = fixture({ [scoped]: resource(audience), [AS]: authorization });
    expect((await discoverPublicOAuth(target, audience, send)).resource).toBe(audience);
    expect(calls).toEqual([scoped, AS]);
    expect(calls.join()).not.toContain('private-capability');
    expect(calls.join()).not.toContain('SECRET');
  });

  test('a provider without resource metadata requires the public field, then uses its OAuth server metadata', async () => {
    const audience = `${ORIGIN}/n8n/mcp-server/http`;
    const values = { [`${ORIGIN}/.well-known/oauth-authorization-server`]: { ...authorization, issuer: ORIGIN } };
    const absent = fixture(values);
    await expect(discoverPublicOAuth(`${audience}?key=SECRET`, undefined, absent.send)).rejects.toBeInstanceOf(OAuthResourceRequired);
    expect(absent.calls).toEqual([PRM]);
    const explicit = fixture(values);
    const result = await discoverPublicOAuth(`${audience}?key=SECRET`, audience, explicit.send);
    expect(result.resource).toBe(audience);
    expect(result.server.issuer).toBe(ORIGIN);
  });

  test('root resource may identify nested transports, but not a same-text path prefix or another origin', async () => {
    for (const target of [`${ORIGIN}/nested/deep/http?key=SECRET`, `${ORIGIN}/mcp`]) {
      const fake = fixture({ [PRM]: resource(ORIGIN), [AS]: authorization });
      expect((await discoverPublicOAuth(target, undefined, fake.send)).resource).toBe(ORIGIN);
    }
    for (const audience of [`${ORIGIN}/other`, `${ORIGIN}/mcp`, 'https://another.example.com/mcp', 'https://mcp.example.com:444/mcp']) {
      const fake = fixture({ [PRM]: resource(audience), [AS]: authorization });
      await expect(discoverPublicOAuth(`${ORIGIN}/mcp-other?key=SECRET`, undefined, fake.send)).rejects.toThrow();
      expect(fake.calls).toEqual([PRM]);
    }
  });

  test('published resource and explicit audience must agree without normalization changing their identity', async () => {
    const explicit = `${ORIGIN}/public/mcp`;
    const fake = fixture({ [`${PRM}/public/mcp`]: resource(`${explicit}/`), [AS]: authorization });
    await expect(discoverPublicOAuth(explicit, explicit, fake.send)).rejects.toThrow('public OAuth metadata');
  });

  test('confidential, malformed, redirected and oversized metadata cannot silently fall back', async () => {
    const invalid = [
      resource(`${ORIGIN}/mcp?key=METADATA_SECRET`),
      resource('https://user:METADATA_SECRET@mcp.example.com/mcp'),
      resource(`${ORIGIN}/mcp#METADATA_SECRET`),
      resource('https://127.0.0.1/mcp'),
      resource('https://mcp.example.com./mcp'),
      { ...resource(), authorization_servers: ['javascript:METADATA_SECRET'] },
      { ...resource(), authorization_servers: [] },
      { ...resource(), scopes_supported: ['read write'] },
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1/METADATA_SECRET' } }),
      new Response('METADATA_SECRET', { status: 503 }),
      new Response('{invalid METADATA_SECRET'),
      new Response(`{"resource":"${'x'.repeat(1024 * 1024)}"}`),
    ];
    for (const value of invalid) {
      const fake = fixture({ [PRM]: value, [AS]: authorization });
      let error = '';
      try { await discoverPublicOAuth(`${ORIGIN}/mcp-server/http?token=TRANSPORT_SECRET`, undefined, fake.send); } catch (err) { error = String(err); }
      expect(error).not.toBe('');
      expect(error).not.toContain('METADATA_SECRET');
      expect(error).not.toContain('TRANSPORT_SECRET');
      expect(fake.calls).toEqual([PRM]);
    }
  });

  test('mismatched issuers and unsafe browser or token destinations fail before registration or authorization', async () => {
    for (const change of [{ issuer: undefined }, { issuer: `${ISSUER}/` }, { issuer: 'https://other.example.com' }, { authorization_endpoint: 'javascript:SECRET' }, { authorization_endpoint: 'https://127.1/authorize' }, { token_endpoint: 'http://identity.example.com/token' }, { registration_endpoint: 'https://user:SECRET@identity.example.com/register' }]) {
      const fake = fixture({ [PRM]: resource(), [AS]: { ...authorization, ...change } });
      await expect(discoverPublicOAuth(`${ORIGIN}/mcp-server/http`, undefined, fake.send)).rejects.toThrow();
      expect(fake.calls).toEqual([PRM, AS]);
    }
  });
});

test('public endpoint and resource validators share boundaries without a provider path allowlist', () => {
  const paths = ['/mcp-server/http', '/providers/deep/tenant/%61/%2F/http', '/server/path?x=SECRET&empty='];
  for (const path of paths) expect(parsePublicConnectorUrl(`${ORIGIN}${path}`).pathname).not.toBe('');
  expect(publicOAuthResource(`${ORIGIN}/providers/%61/http`)).toBe(`${ORIGIN}/providers/%61/http`);
  for (const value of [`${ORIGIN}/?`, `${ORIGIN}/?secret=TOKEN`, `${ORIGIN}/#`, 'https://mcp.example.com./mcp', 'https://[::1]/mcp', 'https://10.0.0.1/mcp', 'https://localhost/mcp', 'https://host.internal/mcp', 'https://@mcp.example.com/mcp']) expect(() => publicOAuthResource(value)).toThrow();
});
