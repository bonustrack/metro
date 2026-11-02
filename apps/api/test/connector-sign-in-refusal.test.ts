import { describe, expect, test } from 'bun:test';
import type { OAuthServer } from '@metro-labs/http/connector-discovery';
import { OwnerTickets } from '../src/agents/tickets.ts';
import { currentClient, type Handoff, type SignInDeps, type SignInState } from '../src/connectors/sign-in.ts';

const CALLBACK = 'https://api.metro.box/api/connectors/callback';
const server: OAuthServer = { issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token', registrationEndpoint: 'https://auth.example/register', supportsS256: true, scopes: [] };

const depsAnswering = (fetchImpl: SignInDeps['fetch']): SignInDeps => ({
  fetch: fetchImpl,
  httpsOnly: true,
  callbackUrl: CALLBACK,
  states: new OwnerTickets<SignInState>((state) => state.connector, { what: 'connector sign-ins' }),
  handoffs: new OwnerTickets<Handoff>((handoff) => handoff.connector, { what: 'connector sign-ins' }),
  now: () => Date.now(),
});

describe('a provider that will not register Metro', () => {
  test('its own reason reaches the page, not a generic sentence', async () => {
    const reason = 'redirect_uri is not allowed. Connect with a Runpod API key instead.';
    const deps = depsAnswering(() => Promise.resolve(new Response(JSON.stringify({ error: 'invalid_redirect_uri', error_description: reason }), { status: 400 })));
    await expect(currentClient(deps, server, { clientId: 'old', redirectUri: 'https://elsewhere/cb' })).rejects.toThrow(`That server refused to register Metro as a client: ${reason}`);
  });

  test('an unreachable server is named as unreachable', async () => {
    const deps = depsAnswering(() => Promise.reject(new TypeError('boom')));
    await expect(currentClient(deps, server, { clientId: 'old', redirectUri: 'https://elsewhere/cb' })).rejects.toThrow('Metro could not reach that server to register');
  });
});
