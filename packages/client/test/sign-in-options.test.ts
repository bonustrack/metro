import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PROVIDERS } from '../src/api/auth.js';
import { loginLinkCode, redeemLoginLink } from '../src/api/login-link.js';
import { fetchSignInOptions, toSignInOptions, WORKOS_SIGN_IN } from '../src/api/sign-in-options.js';
import { configurePlatform, HOSTED_API, memoryKeyValue } from '../src/platform.js';

const API = 'https://api.example';
const CODE = 'aB3_-'.repeat(8).concat('xyz');
const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

let sent: Sent[] = [];

function answer(body: unknown, status = 200): void {
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

function unreachable(): void {
  globalThis.fetch = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
}

const failure = (run: () => Promise<unknown>): Promise<string> => run().then(() => '', (err: unknown) => (err instanceof Error ? err.message : 'not an error'));

beforeEach(() => {
  configurePlatform({ apiBase: API, kv: memoryKeyValue() });
  sent = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  configurePlatform({ kv: memoryKeyValue(), apiBase: HOSTED_API });
});

describe('how people sign in, read from api.metro.box', () => {
  test('an api with WorkOS, or one that names no accounts, keeps today\'s sign-in', () => {
    expect(WORKOS_SIGN_IN).toEqual({ accounts: 'workos', providers: PROVIDERS, emailCode: true });
    expect(toSignInOptions({ mode: 'hosted', owner: null, version: '1' })).toEqual(WORKOS_SIGN_IN);
    expect(toSignInOptions({ mode: 'hosted', accounts: 'workos', providers: ['google'] })).toEqual(WORKOS_SIGN_IN);
    expect(toSignInOptions({ accounts: 'other', providers: ['google'] })).toEqual(WORKOS_SIGN_IN);
    expect(toSignInOptions(null)).toEqual(WORKOS_SIGN_IN);
  });

  test('Metro\'s own accounts offer only the listed Google and Microsoft, in order, and no email code', () => {
    expect(toSignInOptions({ accounts: 'metro', providers: ['microsoft', 'google'] })).toEqual({ accounts: 'metro', providers: ['microsoft', 'google'], emailCode: false });
    expect(toSignInOptions({ accounts: 'metro', providers: ['google', 'github', 'google', 7] })).toEqual({ accounts: 'metro', providers: ['google'], emailCode: false });
    expect(toSignInOptions({ accounts: 'metro', providers: [] })).toEqual({ accounts: 'metro', providers: [], emailCode: false });
    expect(toSignInOptions({ accounts: 'metro' })).toEqual({ accounts: 'metro', providers: [], emailCode: false });
  });

  test('the options come from the api\'s open mode route, and a failed read is an error', async () => {
    answer({ mode: 'hosted', owner: null, version: '1', accounts: 'metro', providers: ['google'] });
    expect(await fetchSignInOptions()).toEqual({ accounts: 'metro', providers: ['google'], emailCode: false });
    expect(sent).toEqual([{ url: `${API}/api/mode`, method: 'GET', body: null }]);
    answer({ error: 'down' }, 503);
    expect(await failure(fetchSignInOptions)).toBe('Metro returned 503.');
    unreachable();
    expect(await failure(fetchSignInOptions)).toBe('Failed to reach Metro.');
  });
});

describe('a login link the operator made', () => {
  test('only #/auth/link/ with a 43 character code is a login link', () => {
    expect(CODE).toHaveLength(43);
    expect(loginLinkCode(`#/auth/link/${CODE}`)).toBe(CODE);
    expect(loginLinkCode(`#/auth/link/${CODE}x`)).toBeNull();
    expect(loginLinkCode(`#/auth/link/${CODE.slice(1)}`)).toBeNull();
    expect(loginLinkCode(`#/auth/link/${CODE.slice(1)}.`)).toBeNull();
    expect(loginLinkCode(`#/auth/link/${CODE}/more`)).toBeNull();
    expect(loginLinkCode(`#/auth/link/${CODE}?x=1`)).toBeNull();
    expect(loginLinkCode(`#/auth/${CODE}`)).toBeNull();
    expect(loginLinkCode(`/auth/link/${CODE}`)).toBeNull();
  });

  test('a working link lands where the api says', async () => {
    answer({ hash: '#/auth/handoff-code-0123456789' });
    expect(await redeemLoginLink(CODE)).toBe('#/auth/handoff-code-0123456789');
    expect(sent).toEqual([{ url: `${API}/api/auth/link`, method: 'POST', body: { code: CODE } }]);
    answer({ hash: '#/login?refused=not-open' });
    expect(await redeemLoginLink(CODE)).toBe('#/login?refused=not-open');
  });

  test('a link that does not work, or too many tries, lands on the login page with the reason', async () => {
    answer({ error: 'unknown link' }, 404);
    expect(await redeemLoginLink(CODE)).toBe('#/login?refused=link');
    answer({ error: 'bad code' }, 400);
    expect(await redeemLoginLink(CODE)).toBe('#/login?refused=link');
    answer({ error: 'slow down' }, 429);
    expect(await redeemLoginLink(CODE)).toBe('#/login?refused=too-many');
  });

  test('anything else is an error', async () => {
    answer({ error: 'down' }, 500);
    expect(await failure(() => redeemLoginLink(CODE))).toBe('Metro returned 500.');
    answer({ hash: 'https://evil.example/#/' });
    expect(await failure(() => redeemLoginLink(CODE))).toBe('Metro returned an unexpected response.');
    answer({});
    expect(await failure(() => redeemLoginLink(CODE))).toBe('Metro returned an unexpected response.');
    unreachable();
    expect(await failure(() => redeemLoginLink(CODE))).toBe('Failed to reach Metro.');
  });
});
