import { describe, expect, test } from 'bun:test';
import { discoverOAuth } from '../src/connector-discovery.ts';

const RESOURCE = new URL('https://vendor.example/mcp');

const serving = (metadata: Record<string, unknown>) => (input: string): Promise<Response> => {
  const path = new URL(input).pathname;
  if (path === '/.well-known/oauth-protected-resource/mcp') return Promise.resolve(Response.json({ authorization_servers: ['https://auth.vendor.example'] }));
  if (path === '/.well-known/oauth-authorization-server') return Promise.resolve(Response.json(metadata));
  return Promise.resolve(new Response('', { status: 404 }));
};

describe('what a connector sign-in may point the browser at', () => {
  test('the advertised endpoints are kept when they are web addresses, through the given fetch', async () => {
    const server = await discoverOAuth(RESOURCE, serving({ issuer: 'https://auth.vendor.example', authorization_endpoint: 'https://auth.vendor.example/authorize', token_endpoint: 'https://auth.vendor.example/token', registration_endpoint: 'https://auth.vendor.example/register' }));
    expect(server).toMatchObject({ authorizationEndpoint: 'https://auth.vendor.example/authorize', tokenEndpoint: 'https://auth.vendor.example/token', registrationEndpoint: 'https://auth.vendor.example/register' });
  });

  test('a script, data or credential-carrying sign-in address is refused before anyone opens it', async () => {
    for (const bad of ['javascript:alert(document.domain)//', 'data:text/html,hi', 'https://user:pass@auth.vendor.example/authorize', 'https://auth.vendor.example/authorize#frag'])
      await expect(discoverOAuth(RESOURCE, serving({ authorization_endpoint: bad, token_endpoint: 'https://auth.vendor.example/token' }))).rejects.toThrow('sign-in address Metro will not open');
    await expect(discoverOAuth(RESOURCE, serving({ authorization_endpoint: 'https://auth.vendor.example/authorize', token_endpoint: 'javascript:void(0)' }))).rejects.toThrow('sign-in address Metro will not open');
  });

  test('a registration address that is not a web address only means Metro cannot register itself', async () => {
    const server = await discoverOAuth(RESOURCE, serving({ authorization_endpoint: 'https://auth.vendor.example/authorize', token_endpoint: 'https://auth.vendor.example/token', registration_endpoint: 'javascript:void(0)' }));
    expect(server.registrationEndpoint).toBeNull();
  });
});
