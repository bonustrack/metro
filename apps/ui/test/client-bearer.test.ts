import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount, storeAccount } from '../src/auth/account.ts';
import { clearIdentity } from '../src/auth/identity.ts';
import { installTestIdentity } from './identity-fixture.ts';
import { call, WalletNeeded } from '../src/api/client.ts';
import { builtInDaemon } from '../src/auth/daemon.ts';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp: number): string => `${b64({ alg: 'RS256' })}.${b64({ sub: 'user_1', org_id: 'org_1', role: 'admin', exp })}.sig`;
const realFetch = globalThis.fetch;
let seen: { url: string; authorization: string | null; body: string | null }[] = [];

function serve(answers: { status: number; body: unknown }[]): void {
  seen = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    const next = answers.shift() ?? { status: 500, body: {} };
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearIdentity();
  clearAccount();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
});

describe('a signed-in account talks to metro.box with a bearer', () => {
  test('a fresh token is sent as is; an expiring one is refreshed first', async () => {
    const soon = Math.floor(Date.now() / 1000) + 5;
    storeAccount({ accessToken: jwt(soon), refreshToken: 'rt_1', organization: 'org_1', role: 'admin', user: { id: 'user_1', email: null, name: null, picture: null } });
    const later = jwt(Math.floor(Date.now() / 1000) + 300);
    serve([
      { status: 200, body: { accessToken: later, refreshToken: 'rt_2', organization: 'org_1', user: { id: 'user_1' } } },
      { status: 200, body: { servers: [] } },
    ]);
    expect(await call({ method: 'GET', base: `${builtInDaemon()}/api/servers` })).toEqual({ servers: [] });
    expect(seen[0]?.url).toBe(`${builtInDaemon()}/api/auth/refresh`);
    expect(seen[0]?.body).toBe(JSON.stringify({ refreshToken: 'rt_1' }));
    expect(seen[1]?.authorization).toBe(`Bearer ${later}`);
  });

  test('a 401 from metro.box is retried once after a refresh', async () => {
    const fresh = jwt(Math.floor(Date.now() / 1000) + 300);
    storeAccount({ accessToken: fresh, refreshToken: 'rt_1', organization: 'org_1', role: 'admin', user: { id: 'user_1', email: null, name: null, picture: null } });
    serve([
      { status: 401, body: { error: 'unauthorized' } },
      { status: 200, body: { accessToken: fresh, refreshToken: 'rt_2', organization: 'org_1', user: { id: 'user_1' } } },
      { status: 200, body: { servers: [] } },
    ]);
    expect(await call({ method: 'GET', base: `${builtInDaemon()}/api/servers` })).toEqual({ servers: [] });
    expect(seen.map((s) => s.url.split('/api/')[1])).toEqual(['servers', 'auth/refresh', 'servers']);
  });

  test('a box is tried with the bearer first; a box that refuses it and has no wallet here asks for the wallet rather than logging out', async () => {
    const fresh = jwt(Math.floor(Date.now() / 1000) + 300);
    storeAccount({ accessToken: fresh, refreshToken: 'rt_1', organization: 'org_1', role: 'admin', user: { id: 'user_1', email: null, name: null, picture: null } });
    serve([{ status: 200, body: { subject: 'org_1', role: 'admin' } }]);
    expect(await call({ method: 'GET', base: 'http://127.0.0.1:8420/api/session' })).toEqual({ subject: 'org_1', role: 'admin' });
    expect(seen[0]?.authorization).toBe(`Bearer ${fresh}`);
    serve([{ status: 401, body: { error: 'unauthorized' } }]);
    await expect(call({ method: 'GET', base: 'http://127.0.0.1:8420/api/session' })).rejects.toBeInstanceOf(WalletNeeded);
    serve([{ status: 403, body: { error: 'this machine belongs to another organization' } }]);
    await expect(call({ method: 'GET', base: 'http://127.0.0.1:8420/api/session' })).rejects.toThrow('another organization');
  });

  test('with the wallet connected, any refusal of the bearer by a box is retried with the wallet, a 500 included', async () => {
    await installTestIdentity();
    storeAccount({ accessToken: jwt(Math.floor(Date.now() / 1000) + 300), refreshToken: 'rt_1', organization: 'org_1', role: 'admin', user: { id: 'user_1', email: null, name: null, picture: null } });
    serve([
      { status: 500, body: { error: 'agent api failed' } },
      { status: 200, body: { agents: [] } },
    ]);
    expect(await call({ method: 'GET', base: 'http://127.0.0.1:8420/api/agents' })).toEqual({ agents: [] });
    expect(seen[0]?.authorization?.startsWith('Bearer ')).toBe(true);
    expect(seen[1]?.authorization?.startsWith('Metro ')).toBe(true);
    clearIdentity();
  });
});
