import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_SIGN_IN, fetchSignInOptions, toSignInOptions } from '../src/api/sign-in-options.js';
import { configurePlatform, HOSTED_API, memoryKeyValue } from '../src/platform.js';

const API = 'https://api.example';
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
  test('when the api cannot be read, the page offers Google and Microsoft', () => {
    expect(DEFAULT_SIGN_IN).toEqual({ providers: ['google', 'microsoft'] });
  });

  test('the api\'s list offers only Google and Microsoft, in order, once each', () => {
    expect(toSignInOptions({ accounts: 'metro', providers: ['microsoft', 'google'] })).toEqual({ providers: ['microsoft', 'google'] });
    expect(toSignInOptions({ accounts: 'metro', providers: ['google', 'github', 'google', 7] })).toEqual({ providers: ['google'] });
    expect(toSignInOptions({ accounts: 'metro', providers: [] })).toEqual({ providers: [] });
    expect(toSignInOptions({ accounts: 'metro' })).toEqual({ providers: [] });
    expect(toSignInOptions(null)).toEqual({ providers: [] });
  });

  test('the options come from the api\'s open mode route, and a failed read is an error', async () => {
    answer({ mode: 'hosted', owner: null, version: '1', accounts: 'metro', providers: ['google'] });
    expect(await fetchSignInOptions()).toEqual({ providers: ['google'] });
    expect(sent).toEqual([{ url: `${API}/api/mode`, method: 'GET', body: null }]);
    answer({ error: 'down' }, 503);
    expect(await failure(fetchSignInOptions)).toBe('Metro returned 503.');
    unreachable();
    expect(await failure(fetchSignInOptions)).toBe('Failed to reach Metro.');
  });
});
