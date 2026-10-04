import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount, storeAccount } from '../src/auth/account.ts';
import { AuthError, call } from '../src/api/client.ts';
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

const account = (accessToken: string): void => {
  storeAccount({ accessToken, refreshToken: 'rt_1', organization: 'org_1', organizationName: null, role: 'admin', user: { id: 'user_1', email: null, name: null, picture: null } });
};

beforeEach(() => {
  clearAccount();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
});

describe('every request carries the account token', () => {
  test('a fresh token is sent as is; an expiring one is refreshed first', async () => {
    account(jwt(Math.floor(Date.now() / 1000) + 5));
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

  test('a 401 is retried once after a refresh, on metro.box and on a box alike', async () => {
    const fresh = jwt(Math.floor(Date.now() / 1000) + 300);
    account(fresh);
    serve([
      { status: 401, body: { error: 'unauthorized' } },
      { status: 200, body: { accessToken: fresh, refreshToken: 'rt_2', organization: 'org_1', user: { id: 'user_1' } } },
      { status: 200, body: { subject: 'org_1', role: 'admin' } },
    ]);
    expect(await call({ method: 'GET', base: 'http://127.0.0.1:8420/api/session' })).toEqual({ subject: 'org_1', role: 'admin' });
    expect(seen.map((s) => s.url.split('/api/')[1])).toEqual(['session', 'auth/refresh', 'session']);
  });

  test('with no account the call is refused before any request; a 403 from a box is an error with its message', async () => {
    serve([]);
    await expect(call({ method: 'GET', base: 'http://127.0.0.1:8420/api/session' })).rejects.toBeInstanceOf(AuthError);
    expect(seen).toEqual([]);
    account(jwt(Math.floor(Date.now() / 1000) + 300));
    serve([{ status: 403, body: { error: 'this machine belongs to another organization' } }]);
    await expect(call({ method: 'GET', base: 'http://127.0.0.1:8420/api/session' })).rejects.toThrow('another organization');
  });
});
