import { describe, expect, test } from 'bun:test';
import type { OAuthServer } from '../src/connector-discovery.ts';
import { registerClient } from '../src/connector-oauth.ts';

const server: OAuthServer = { issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token', registrationEndpoint: 'https://auth.example/register', supportsS256: true, scopes: [] };
const answer = (status: number, body: unknown) => () => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const RUNPOD = 'redirect_uri is not allowed. It must be a registered client callback or a loopback address. Connect with a Runpod API key instead.';

describe('a registration the server refuses', () => {
  test('names the reason the server gave, so the admin knows what to do', async () => {
    await expect(registerClient(server, 'https://api.metro.box/api/connectors/callback', answer(400, { error: 'invalid_redirect_uri', error_description: RUNPOD }))).rejects.toThrow(`That server refused to register Metro as a client: ${RUNPOD}`);
  });

  test('falls back to the error code, then to no reason at all', async () => {
    await expect(registerClient(server, 'https://cb', answer(400, { error: 'invalid_client_metadata' }))).rejects.toThrow('That server refused to register Metro as a client: invalid_client_metadata');
    await expect(registerClient(server, 'https://cb', answer(500, 'down'))).rejects.toThrow('That server refused to register Metro as a client.');
  });

  test('keeps the reason on one bounded line', async () => {
    const err = await registerClient(server, 'https://cb', answer(400, { error_description: `bad\nline\u0007${'x'.repeat(2000)}` })).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toStartWith('That server refused to register Metro as a client: bad line ');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(700);
  });
});
