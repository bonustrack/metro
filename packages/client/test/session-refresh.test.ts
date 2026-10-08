import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accessToken, refreshAccount } from '../src/api/auth.js';
import { AuthError, call, callRaw } from '../src/api/client.js';
import { activeAccount, clearAccount } from '../src/auth/account.js';
import { installTestAccount, testToken } from './account-fixture.js';

const realFetch = globalThis.fetch;
let requests: string[] = [];
let respond: (path: string) => Promise<Response>;

beforeEach(() => {
  requests = [];
  clearAccount();
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(path);
    return respond(path);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
});

const session = { method: 'GET', base: 'https://box.test/api/session' } as const;

function unreadable(status: number, error: Error): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } }), { status });
}

function unavailable(kind: number | 'offline' | 'timeout' | 'body-offline' | 'body-timeout'): Promise<Response> {
  if (kind === 'offline') return Promise.reject(new TypeError('Network request failed'));
  if (kind === 'timeout') return Promise.reject(new DOMException('Timed out', 'TimeoutError'));
  if (kind === 'body-offline') return Promise.resolve(unreadable(200, new TypeError('Connection lost')));
  if (kind === 'body-timeout') return Promise.resolve(unreadable(200, new DOMException('Timed out', 'TimeoutError')));
  return Promise.resolve(Response.json({ error: 'Temporarily unavailable' }, { status: kind }));
}

function recovered(): void {
  const account = activeAccount();
  respond = (path) => Promise.resolve(Response.json(path === '/api/auth/refresh'
    ? { ...account, accessToken: testToken(), refreshToken: 'rt_recovered' }
    : { subject: 'user_1' }));
}

describe('temporary refresh failures do not end the Metro session', () => {
  test.each([429, 500, 502, 503, 504, 'offline', 'timeout', 'body-offline', 'body-timeout'] as const)('an expiring token keeps its session on %s and recovers on the next request', async (kind) => {
    const original = installTestAccount({ exp: 1 });
    respond = () => unavailable(kind);
    const error = await call(session).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(activeAccount()).toEqual(original);
    expect(requests).toEqual(['/api/auth/refresh']);
    recovered();
    expect(await call(session)).toEqual({ subject: 'user_1' });
    expect(activeAccount()?.refreshToken).toBe('rt_recovered');
    expect(requests).toEqual(['/api/auth/refresh', '/api/auth/refresh', '/api/session']);
  });

  test.each([call, callRaw])('a box 401 followed by an unavailable refresh is not a sign-out for %p', async (request) => {
    const original = installTestAccount();
    respond = (path) => path === '/api/session'
      ? Promise.resolve(Response.json({}, { status: 401 }))
      : unavailable('offline');
    const error = await request(session).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(activeAccount()).toEqual(original);
    expect(requests).toEqual(['/api/session', '/api/auth/refresh']);
  });

  test('direct refresh callers receive the temporary failure without losing the session', async () => {
    const original = installTestAccount();
    respond = () => unavailable(503);
    await expect(refreshAccount()).rejects.toThrow('Temporarily unavailable');
    expect(activeAccount()).toEqual(original);
  });

  test('a definitively rejected refresh still clears the account and returns an auth error', async () => {
    installTestAccount({ exp: 1 });
    respond = () => Promise.resolve(Response.json({ error: 'The session ended' }, { status: 401 }));
    await expect(call(session)).rejects.toBeInstanceOf(AuthError);
    expect(activeAccount()).toBeNull();
    expect(requests).toEqual(['/api/auth/refresh']);
    expect(await accessToken()).toBeNull();
  });

  test.each([401, 503])('an unreadable error body preserves HTTP%s classification', async (status) => {
    const original = installTestAccount({ exp: 1 });
    respond = () => Promise.resolve(unreadable(status, new TypeError('Connection lost')));
    const error = await call(session).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof AuthError).toBe(status === 401);
    expect(activeAccount()).toEqual(status === 401 ? null : original);
    expect(requests).toEqual(['/api/auth/refresh']);
  });

  test('malformed successful JSON still clears the account', async () => {
    installTestAccount({ exp: 1 });
    respond = () => Promise.resolve(new Response('{invalid json'));
    await expect(call(session)).rejects.toBeInstanceOf(AuthError);
    expect(activeAccount()).toBeNull();
    expect(requests).toEqual(['/api/auth/refresh']);
  });

  test('an invalid successful refresh is still rejected without sending its token to a box', async () => {
    installTestAccount({ exp: 1 });
    respond = () => Promise.resolve(Response.json({ accessToken: testToken({ sub: 'other_user' }), refreshToken: 'rt_wrong', user: { id: 'other_user' } }));
    await expect(call(session)).rejects.toBeInstanceOf(AuthError);
    expect(activeAccount()).toBeNull();
    expect(requests).toEqual(['/api/auth/refresh']);
  });
});
