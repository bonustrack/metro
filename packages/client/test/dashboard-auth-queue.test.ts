import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { logoutAccount, refreshAccount, scopedOrganizationAccessToken } from '../src/api/auth.js';
import { accountScopeIdentity, activeAccount, clearAccount, loadAccount, subscribeAccountScope, type Account } from '../src/auth/account.js';
import { configurePlatform, HOSTED_API, memoryKeyValue, type KeyValue } from '../src/platform.js';
import { installTestAccount, testToken } from './account-fixture.js';

const SOURCE = 'org_source';
const TARGET = 'org_target';
const OTHER = 'org_other';
const realFetch = globalThis.fetch;
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let kv: KeyValue;
let calls: { path: string; organization: unknown; refreshToken: unknown }[];
let source: Account;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function answer(organization: string, refreshToken: string): Response {
  return Response.json({ accessToken: testToken({ org_id: organization, role: 'member' }), refreshToken, organization, user: source.user });
}

function browserFixture(): { lock: <T>(run: () => Promise<T>) => Promise<T>; changed: () => void } {
  let tail: Promise<void> = Promise.resolve();
  const callbacks = new Set<(event: { key: string }) => void>();
  const lock = <T>(run: () => Promise<T>): Promise<T> => {
    const pending = tail.then(run);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { document: {},
    addEventListener: (_type: string, callback: (event: { key: string }) => void) => callbacks.add(callback),
    removeEventListener: (_type: string, callback: (event: { key: string }) => void) => callbacks.delete(callback),
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request: <T>(name: string, run: () => Promise<T>) => { expect(name).toBe('metro.account'); return lock(run); },
  } } });
  activeAccount();
  return { lock, changed: () => { for (const callback of callbacks) callback({ key: 'metro.account' }); } };
}

function foreignAccount(changes: Record<string, unknown>): void {
  const body = JSON.parse(kv.getItem('metro.account') ?? '{}') as Record<string, unknown>;
  kv.setItem('metro.account', JSON.stringify({ ...body, ...changes }));
}

beforeEach(() => {
  kv = memoryKeyValue();
  configurePlatform({ kv, apiBase: 'https://auth.example' });
  source = installTestAccount({ org_id: SOURCE, role: 'member' });
  calls = [];
  const consumed = new Set<string>();
  let sequence = 0;
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, organization: body.organization, refreshToken: body.refreshToken });
    if (path.endsWith('/logout')) return Promise.resolve(Response.json({ ok: true }));
    if (typeof body.refreshToken !== 'string' || consumed.has(body.refreshToken)) throw new Error('Invalid or reused fixture refresh token');
    consumed.add(body.refreshToken);
    sequence += 1;
    return Promise.resolve(answer(typeof body.organization === 'string' ? body.organization : SOURCE, `rt_${String(sequence)}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (realWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', realWindow);
  if (realNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
  else Object.defineProperty(globalThis, 'navigator', realNavigator);
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue(), apiBase: HOSTED_API });
});

const outcome = (pending: Promise<unknown>): Promise<unknown> => pending.catch((error: unknown) => error);

describe('queued and refused dashboard organization access', () => {
  for (const status of [403, 404]) {
    test(`pre-rotation ${String(status)} preserves the valid source session for another membership`, async () => {
      const serve = globalThis.fetch;
      globalThis.fetch = ((url: string, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return body.organization === TARGET ? Promise.resolve(Response.json({ error: 'Membership refused' }, { status })) : serve(url, init);
      }) as unknown as typeof fetch;
      const scope = accountScopeIdentity();
      await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow('Membership refused');
      expect(activeAccount()).toBe(source);
      expect(accountScopeIdentity()).toBe(scope);
      await scopedOrganizationAccessToken(OTHER);
      expect(calls.map((call) => call.refreshToken)).toEqual(['rt_test', 'rt_1']);
      expect(activeAccount()?.organization).toBe(SOURCE);
    });
  }

  test('a queued flight with every subscriber cancelled never begins rotation', async () => {
    const serve = globalThis.fetch;
    const started = deferred<void>();
    const response = deferred<Response>();
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/refresh')) { started.resolve(); return response.promise; }
      return serve(url, init);
    }) as unknown as typeof fetch;
    const refresh = refreshAccount();
    await started.promise;
    const first = new AbortController();
    const second = new AbortController();
    const a = outcome(scopedOrganizationAccessToken(TARGET, { signal: first.signal }));
    const b = outcome(scopedOrganizationAccessToken(TARGET, { signal: second.signal }));
    first.abort();
    second.abort();
    expect(await a).toHaveProperty('name', 'AbortError');
    expect(await b).toHaveProperty('name', 'AbortError');
    response.resolve(answer(SOURCE, 'rt_refreshed'));
    await refresh;
    await scopedOrganizationAccessToken(SOURCE);
    expect(calls).toEqual([]);
    expect(activeAccount()?.refreshToken).toBe('rt_refreshed');
  });

  test('an aborted subscriber settles before a started rotation finishes restoring', async () => {
    const serve = globalThis.fetch;
    const started = deferred<void>();
    const response = deferred<Response>();
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.organization === TARGET) { started.resolve(); return response.promise; }
      return serve(url, init);
    }) as unknown as typeof fetch;
    const abort = new AbortController();
    const pending = outcome(scopedOrganizationAccessToken(TARGET, { signal: abort.signal }));
    await started.promise;
    abort.abort();
    expect(await pending).toHaveProperty('name', 'AbortError');
    expect(activeAccount()?.refreshToken).toBe('rt_test');
    response.resolve(answer(TARGET, 'rt_destination'));
    await scopedOrganizationAccessToken(SOURCE);
    expect(calls.map((call) => call.organization)).toEqual([SOURCE]);
    expect(activeAccount()?.refreshToken).toBe('rt_1');
  });

  test('one live queued subscriber still gets its shared destination token', async () => {
    const browser = browserFixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const held = browser.lock(async () => { started.resolve(); await release.promise; });
    await started.promise;
    const abort = new AbortController();
    const cancelled = outcome(scopedOrganizationAccessToken(TARGET, { signal: abort.signal }));
    const retained = scopedOrganizationAccessToken(TARGET);
    abort.abort();
    release.resolve();
    await held;
    expect(await cancelled).toHaveProperty('name', 'AbortError');
    expect(await retained).toBe(testToken({ org_id: TARGET, role: 'member' }));
    expect(calls.map((call) => call.organization)).toEqual([TARGET, SOURCE]);
  });
});

describe('browser-wide source credential rotation', () => {
  test('a waiting tab uses the other tab’s restored refresh token without changing its scope', async () => {
    const browser = browserFixture();
    const scope = accountScopeIdentity();
    const changes: number[] = [];
    const unsubscribe = subscribeAccountScope(() => { changes.push(accountScopeIdentity()); });
    const started = deferred<void>();
    const release = deferred<void>();
    const otherTab = browser.lock(async () => {
      started.resolve();
      await release.promise;
      foreignAccount({ refreshToken: 'rt_other_tab_restored' });
      browser.changed();
    });
    await started.promise;
    const pending = scopedOrganizationAccessToken(TARGET);
    await Promise.resolve();
    expect(calls).toEqual([]);
    release.resolve();
    try {
      await Promise.all([otherTab, pending]);
      expect(calls.map((call) => call.refreshToken)).toEqual(['rt_other_tab_restored', 'rt_1']);
      expect(activeAccount()?.refreshToken).toBe('rt_2');
      expect(accountScopeIdentity()).toBe(scope);
      expect(changes).toEqual([]);
    } finally { unsubscribe(); }
  });

  test('same-user same-organization login gets a new marker even with an unchanged token sid', () => {
    browserFixture();
    const previous = kv.getItem('metro.account');
    const scope = accountScopeIdentity();
    const loggedIn = installTestAccount({ org_id: SOURCE, role: 'member' });
    expect(loggedIn.accessToken).toBe(source.accessToken);
    expect(kv.getItem('metro.account')).not.toBe(previous);
    expect(accountScopeIdentity()).not.toBe(scope);
  });

  test('a foreign login invalidates queued work before it can consume the replacement session', async () => {
    const browser = browserFixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const otherTab = browser.lock(async () => {
      started.resolve();
      await release.promise;
      foreignAccount({ refreshToken: 'rt_new_login', sessionScope: 'replacement_login' });
    });
    await started.promise;
    const pending = outcome(scopedOrganizationAccessToken(TARGET));
    release.resolve();
    await otherTab;
    expect(await pending).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
    expect(activeAccount()?.refreshToken).toBe('rt_new_login');
  });

  test('foreign logout clears cached account and notifies scope subscribers immediately', () => {
    const browser = browserFixture();
    let changes = 0;
    const unsubscribe = subscribeAccountScope(() => { changes += 1; });
    try {
      kv.removeItem('metro.account');
      browser.changed();
      expect(changes).toBe(1);
      expect(activeAccount()).toBeNull();
    } finally { unsubscribe(); }
  });

  test('logout during rotation completes restoration but cannot restore the signed-out account', async () => {
    browserFixture();
    const serve = globalThis.fetch;
    const started = deferred<void>();
    const response = deferred<Response>();
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.organization === TARGET) { started.resolve(); return response.promise; }
      return serve(url, init);
    }) as unknown as typeof fetch;
    const pending = outcome(scopedOrganizationAccessToken(TARGET));
    await started.promise;
    const loggedOut = logoutAccount();
    expect(activeAccount()).toBeNull();
    await expect(scopedOrganizationAccessToken(SOURCE)).rejects.toThrow('Log in first');
    response.resolve(answer(TARGET, 'rt_destination'));
    expect(await pending).toBeInstanceOf(Error);
    await loggedOut;
    expect(calls.some((call) => call.organization === SOURCE)).toBe(true);
    expect(activeAccount()).toBeNull();
    expect(kv.getItem('metro.account')).toBeNull();
  });

  test('logout masks foreign restoration until the shared clear commits under its lock', async () => {
    const browser = browserFixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const restored = browser.lock(async () => {
      started.resolve();
      await release.promise;
      foreignAccount({ refreshToken: 'rt_foreign_restored' });
      browser.changed();
      expect(activeAccount()).toBeNull();
    });
    await started.promise;
    const loggedOut = logoutAccount();
    expect(activeAccount()).toBeNull();
    expect(await refreshAccount()).toBeNull();
    release.resolve();
    await Promise.all([restored, loggedOut]);
    expect(activeAccount()).toBeNull();
    expect(kv.getItem('metro.account')).toBeNull();
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/logout']);
  });

  test('a browser without Web Locks refuses rotation without consuming a credential', async () => {
    browserFixture();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow('Web Locks');
    expect(activeAccount()).toBe(source);
    expect(calls).toEqual([]);
  });

  test('legacy records without a marker survive rotation with a stable migrated scope', async () => {
    kv.setItem('metro.account', JSON.stringify(source));
    loadAccount();
    browserFixture();
    const scope = accountScopeIdentity();
    await scopedOrganizationAccessToken(TARGET);
    expect(accountScopeIdentity()).toBe(scope);
    expect(JSON.parse(kv.getItem('metro.account') ?? '{}')).toHaveProperty('sessionScope');
  });
});
