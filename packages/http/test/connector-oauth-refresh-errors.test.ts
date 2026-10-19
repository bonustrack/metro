import { describe, expect, test } from 'bun:test';
import { OAuthInvalidGrant, refreshTokens } from '../src/connector-oauth.ts';

const server = { issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token', scopes: [] };
const answer = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('a refresh the server refuses', () => {
  test('a dead grant or client asks for a new sign-in', async () => {
    for (const [status, error] of [[400, 'invalid_grant'], [401, 'invalid_client'], [400, 'unauthorized_client']] as const)
      await expect(refreshTokens(server, { clientId: 'c' }, 'r', 'https://mcp.example', undefined, answer(status, { error }))).rejects.toBeInstanceOf(OAuthInvalidGrant);
  });

  test('any other refusal names the status and the error code', async () => {
    await expect(refreshTokens(server, { clientId: 'c' }, 'r', 'https://mcp.example', undefined, answer(400, { error: 'invalid_request' }))).rejects.toThrow('That server refused to complete the sign-in (400 invalid_request).');
    await expect(refreshTokens(server, { clientId: 'c' }, 'r', 'https://mcp.example', undefined, answer(503, 'down'))).rejects.toThrow('That server refused to complete the sign-in (503).');
  });
});
