import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { verifyMessage } from 'viem';
import { activeIdentity, clearIdentity, identityFrom } from '../src/auth/identity';
import { AuthError, call } from '../src/api/client';
import { requestChallenge } from '../src/vault/crypto';
import { setCurrentServer } from '../src/auth/daemon';
import { installTestIdentity, TEST_IDENTITY_ADDRESS, TEST_SIGNATURE, TEST_WALLET } from './identity-fixture';

interface Seen {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  body: string | undefined;
}

const realFetch = globalThis.fetch;
let seen: Seen[] = [];

function serve(answer: (seen: Seen) => Response): void {
  seen = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const entry = { url, method: init?.method, authorization: headers.authorization, body: init?.body as string | undefined };
    seen.push(entry);
    return Promise.resolve(answer(entry));
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  await installTestIdentity();
  setCurrentServer({ id: 'aB3-_xYz9Qw', host: '127.0.0.1:8420' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearIdentity();
  setCurrentServer(null);
});

describe('the identity derived from the sign-in signature', () => {
  test('derives the same request-signing account the daemon expects for this signature', async () => {
    const identity = await identityFrom(TEST_WALLET, TEST_SIGNATURE);
    expect(identity.vault.address.toLowerCase()).toBe(TEST_IDENTITY_ADDRESS);
    expect(identity.address).toBe(TEST_WALLET);
    expect(identity.signature).toBe(TEST_SIGNATURE);
    expect(activeIdentity()?.vault.address.toLowerCase()).toBe(TEST_IDENTITY_ADDRESS);
  });

  test('every call carries a fresh signature over the method, the path and the time', async () => {
    serve(() => json({ ok: true }));
    await call({ method: 'POST', path: '/x?y=1', body: '{}' });
    const [first] = seen;
    const [scheme, address, at, signature] = (first?.authorization ?? '').split(' ');
    expect(scheme).toBe('Metro');
    expect(address?.toLowerCase()).toBe(TEST_IDENTITY_ADDRESS);
    expect(Math.abs(Number(at) - Date.now())).toBeLessThan(10_000);
    const message = requestChallenge('POST', new URL(first?.url ?? '').pathname, Number(at));
    expect(await verifyMessage({ address: TEST_IDENTITY_ADDRESS as `0x${string}`, message, signature: signature as `0x${string}` })).toBe(true);
  });

  test('a daemon that forgot the identity gets it registered once, then the call is retried', async () => {
    let registered = false;
    serve((req) => {
      if (req.url.endsWith('/auth/identity')) {
        registered = true;
        expect(req.body).toBe(JSON.stringify({ signature: TEST_SIGNATURE }));
        return json({ address: TEST_IDENTITY_ADDRESS, owner: TEST_WALLET });
      }
      return registered ? json({ agents: [] }) : json({ error: 'unauthorized' }, 401);
    });
    expect(await call({ method: 'GET' })).toEqual({ agents: [] });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/api/agents', '/auth/identity', '/api/agents']);
  });

  test('a daemon that belongs to another wallet refuses the registration, and that is the error shown', async () => {
    serve((req) =>
      req.url.endsWith('/auth/identity') ? json({ error: 'this machine belongs to another wallet' }, 403) : json({ error: 'unauthorized' }, 401),
    );
    await expect(call({ method: 'GET' })).rejects.toThrow(AuthError);
    await expect(call({ method: 'GET' })).rejects.toThrow('another wallet');
  });

  test('a refusal from metro.box never triggers a registration there', async () => {
    serve(() => json({ error: 'unauthorized' }, 401));
    await expect(call({ method: 'GET', base: 'https://vault.example.test/api/vault' })).rejects.toThrow(AuthError);
    expect(seen.map((s) => s.url)).toEqual(['https://vault.example.test/api/vault']);
  });

  test('without an identity nothing is sent at all', async () => {
    clearIdentity();
    serve(() => json({}));
    await expect(call({ method: 'GET' })).rejects.toThrow(AuthError);
    expect(seen).toEqual([]);
  });
});
