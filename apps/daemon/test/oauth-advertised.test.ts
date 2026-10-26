import { describe, expect, test } from 'bun:test';
import {
  authServerMetadataUrls,
  resourceMetadataUrls,
} from '@metro-labs/http/connector-discovery';

const GMAIL = new URL('https://gmailmcp.googleapis.com/mcp/v1');

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
});
