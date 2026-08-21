import { afterEach, describe, expect, test } from 'bun:test';
import {
  advertisesOAuth,
  authServerMetadataUrls,
  resourceMetadataUrls,
} from '../src/daemon/oauth-discovery.ts';

const GMAIL = new URL('https://gmailmcp.googleapis.com/mcp/v1');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let asked: string[] = [];

function serve(routes: Record<string, unknown>): void {
  asked = [];
  globalThis.fetch = ((url: URL | string) => {
    const href = url.toString();
    asked.push(href);
    const body = routes[href];
    if (body === undefined) return Promise.resolve(new Response('no', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

describe('an authorization server with a path is still findable', () => {
  const withPath = new URL('https://mcp.pscale.dev/mcp/planetscale');

  test('the path goes AFTER the well-known suffix, which is what RFC 8414 says', () => {
    expect(authServerMetadataUrls(withPath).map((u) => u.toString())).toEqual([
      'https://mcp.pscale.dev/.well-known/oauth-authorization-server/mcp/planetscale',
      'https://mcp.pscale.dev/.well-known/openid-configuration/mcp/planetscale',
      'https://mcp.pscale.dev/mcp/planetscale/.well-known/openid-configuration',
      'https://mcp.pscale.dev/.well-known/oauth-authorization-server',
      'https://mcp.pscale.dev/.well-known/openid-configuration',
    ]);
  });

  test('the root-only form is tried too, since that is where metro used to look alone', () => {
    expect(authServerMetadataUrls(withPath).map((u) => u.pathname)).toContain(
      '/.well-known/oauth-authorization-server',
    );
  });

  test('a path-less issuer keeps the two plain candidates and no duplicates', () => {
    expect(
      authServerMetadataUrls(new URL('https://accounts.google.com')).map((u) =>
        u.toString(),
      ),
    ).toEqual([
      'https://accounts.google.com/.well-known/oauth-authorization-server',
      'https://accounts.google.com/.well-known/openid-configuration',
    ]);
  });

  test('a trailing slash on the issuer does not become an empty path segment', () => {
    expect(
      authServerMetadataUrls(new URL('https://accounts.google.com/')).map((u) =>
        u.toString(),
      ),
    ).toEqual([
      'https://accounts.google.com/.well-known/oauth-authorization-server',
      'https://accounts.google.com/.well-known/openid-configuration',
    ]);
  });
});

describe('a server that only says it is protected is still protected', () => {
  test('the path-aware well-known is asked first, then the root', () => {
    expect(resourceMetadataUrls(GMAIL).map((u) => u.toString())).toEqual([
      'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1',
      'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource',
    ]);
  });

  test('gmail advertises an authorization server, so it needs signing in', async () => {
    serve({
      'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1':
        {
          authorization_servers: ['https://accounts.google.com/'],
          resource: 'https://gmailmcp.googleapis.com/mcp/v1',
        },
    });
    expect(await advertisesOAuth(GMAIL)).toBe(true);
  });

  test('a server publishing nothing is taken at its word', async () => {
    serve({});
    expect(await advertisesOAuth(GMAIL)).toBe(false);
  });

  test('metadata with an empty authorization_servers is not a sign-in', async () => {
    serve({
      'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1':
        { authorization_servers: [] },
    });
    expect(await advertisesOAuth(GMAIL)).toBe(false);
  });

  test('a network failure reads as no sign-in rather than throwing', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await advertisesOAuth(GMAIL)).toBe(false);
  });
});
