import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accessToken, exchangeHandoff, fetchOrganizations, logoutAccount, organizationAccessToken, refreshAccount, scopedOrganizationAccessToken, switchOrganization } from '../src/api/auth.js';
import { accountScopeIdentity, activeAccount, clearAccount, loadAccount, storeAccount, subscribeAccountScope, tokenExpiring, tokenExpiry, type Account } from '../src/auth/account.js';
import { currentServer, setCurrentServer } from '../src/auth/daemon.js';
import { AuthError, call } from '../src/api/client.js';
import { configurePlatform, HOSTED_API, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, testToken } from './account-fixture.js';

const SOURCE = 'org_source';
const TARGET = 'org_target';
const OTHER = 'org_other';
const realFetch = globalThis.fetch;
interface Call { path: string; body: Record<string, unknown>; init: RequestInit }
let calls: Call[] = [];
let persisted: Account[] = [];
let roles = new Map<string, string>();
let transform: (call: Call, account: Account) => Promise<Response>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function hold(predicate: (call: Call) => boolean): { started: Promise<Account>; release: (response: Response) => void } {
  const started = deferred<Account>();
  const held = deferred<Response>();
  transform = (call, account) => {
    if (!predicate(call)) return Promise.resolve(Response.json(account));
    started.resolve(account);
    return held.promise;
  };
  return { started: started.promise, release: held.resolve };
}

beforeEach(() => {
  const kv = memoryKeyValue();
  persisted = [];
  configurePlatform({ apiBase: 'https://auth.example', kv: { ...kv, setItem: (key, value) => {
    kv.setItem(key, value);
    if (key === 'metro.account') persisted.push(JSON.parse(value) as Account);
  } } });
  installTestAccount({ org_id: SOURCE, role: 'member' });
  setCurrentServer({ id: 'source_agent', host: 'source.example' });
  calls = [];
  roles = new Map();
  const used = new Set<string>();
  const user = activeAccount()?.user;
  let sequence = 0;
  transform = (_call, account) => Promise.resolve(Response.json(account));
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const call = { path, body, init };
    calls.push(call);
    if (path.endsWith('/logout')) return Promise.resolve(Response.json({ ok: true }));
    if (!['/api/auth/switch', '/api/auth/refresh', '/api/auth/exchange'].includes(path)) throw new Error('Unexpected fixture request');
    if (typeof body.refreshToken === 'string') {
      if (used.has(body.refreshToken)) throw new Error('Refresh token used twice');
      used.add(body.refreshToken);
    }
    sequence += 1;
    const organization = typeof body.organization === 'string' ? body.organization : SOURCE;
    return transform(call, { accessToken: testToken({ org_id: organization, role: roles.get(organization) ?? 'member' }), refreshToken: `rt_${String(sequence)}`, organization, user } as Account);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
  setCurrentServer(null);
  configurePlatform({ kv: memoryKeyValue(), apiBase: HOSTED_API });
});

const switches = (): unknown[] => calls.filter((call) => call.path.endsWith('/switch')).map((call) => call.body.organization);
const outcome = (pending: Promise<unknown>): Promise<unknown> => pending.catch((error: unknown) => error);

describe('source-preserving organization access for the dashboard', () => {
  test('members get only the destination bearer, with no selected organization or agent change and no destination persistence', async () => {
    const scope = accountScopeIdentity();
    const selected = currentServer();
    const token = await scopedOrganizationAccessToken(TARGET);
    expect(token).toBe(testToken({ org_id: TARGET, role: 'member' }));
    expect(switches()).toEqual([TARGET, SOURCE]);
    expect(calls.map((call) => call.body.refreshToken)).toEqual(['rt_test', 'rt_1']);
    expect(calls.every((call) => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal)).toBe(true);
    expect(persisted.map((account) => account.organization)).toEqual([SOURCE, SOURCE]);
    expect(persisted.some((account) => account.accessToken === token)).toBe(false);
    expect(activeAccount()?.refreshToken).toBe('rt_2');
    expect(activeAccount()?.organization).toBe(SOURCE);
    expect(accountScopeIdentity()).toBe(scope);
    expect(currentServer()).toBe(selected);
  });

  test('current-organization members use their existing token without rotation', async () => {
    expect(await scopedOrganizationAccessToken(SOURCE)).toBe(activeAccount()?.accessToken ?? '');
    expect(calls).toHaveLength(0);
    await expect(organizationAccessToken(SOURCE)).rejects.toThrow('admin');
  });

  test('singleflight shares simultaneous reads but retains no completed token cache', async () => {
    const tokens = await Promise.all([scopedOrganizationAccessToken(TARGET), scopedOrganizationAccessToken(TARGET), scopedOrganizationAccessToken(OTHER)]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(switches()).toEqual([TARGET, SOURCE, OTHER, SOURCE]);
    expect(calls.map((call) => call.body.refreshToken)).toEqual(['rt_test', 'rt_1', 'rt_2', 'rt_3']);
    await scopedOrganizationAccessToken(TARGET);
    expect(switches()).toEqual([TARGET, SOURCE, OTHER, SOURCE, TARGET, SOURCE]);
  });

  test('copy still requires both admin roles while sharing the rotation queue with member reads', async () => {
    installTestAccount({ org_id: SOURCE });
    roles.set(SOURCE, 'admin');
    await expect(organizationAccessToken(TARGET)).rejects.toThrow('admin of the destination');
    roles.set(TARGET, 'admin');
    const results = await Promise.all([scopedOrganizationAccessToken(OTHER), organizationAccessToken(TARGET)]);
    expect(results).toHaveLength(2);
    expect(calls.map((call) => call.body.refreshToken)).toEqual(['rt_test', 'rt_1', 'rt_2', 'rt_3', 'rt_4', 'rt_5']);
    expect(activeAccount()?.organization).toBe(SOURCE);
  });

  test('expired sources refresh once, with no fallback or repeated refresh for unusable tokens', async () => {
    installTestAccount({ org_id: SOURCE, role: 'member', exp: 1 });
    const scope = accountScopeIdentity();
    await Promise.all([scopedOrganizationAccessToken(TARGET), scopedOrganizationAccessToken(OTHER)]);
    expect(calls.map((call) => call.path.split('/').at(-1))).toEqual(['refresh', 'switch', 'switch', 'switch', 'switch']);
    expect(accountScopeIdentity()).toBe(scope);
    storeAccount({ ...installTestAccount({ org_id: SOURCE, role: 'member', exp: 1 }), refreshToken: 'rt_relogin' });
    transform = (_call, account) => Promise.resolve(Response.json({ ...account, accessToken: testToken({ org_id: SOURCE, exp: 1 }) }));
    const previous = calls.length;
    expect(await accessToken()).toBeNull();
    expect(calls.slice(previous).map((call) => call.path)).toEqual(['/api/auth/refresh']);
  });

  test('held refresh and dashboard token acquisition never consume the same refresh token', async () => {
    const held = hold((call) => call.path.endsWith('/refresh'));
    const refreshed = refreshAccount();
    const response = await held.started;
    const dashboard = scopedOrganizationAccessToken(TARGET);
    await Promise.resolve();
    expect(switches()).toEqual([]);
    held.release(Response.json(response));
    await Promise.all([refreshed, dashboard]);
    expect(calls.map((call) => call.body.refreshToken)).toEqual(['rt_test', 'rt_1', 'rt_2']);
  });

  test('restoration is completed before refresh waiters or an explicit switch can run', async () => {
    const scope = accountScopeIdentity();
    const held = hold((call) => call.body.organization === SOURCE);
    const dashboard = outcome(scopedOrganizationAccessToken(TARGET));
    const response = await held.started;
    const refreshed = refreshAccount();
    const switched = switchOrganization(OTHER);
    expect(switches()).toEqual([TARGET, SOURCE]);
    held.release(Response.json(response));
    expect((await refreshed)?.organization).toBe(SOURCE);
    await Promise.all([dashboard, switched]);
    expect(switches()).toEqual([TARGET, SOURCE, OTHER]);
    expect(calls.at(-1)?.body.refreshToken).toBe('rt_2');
    expect(activeAccount()?.organization).toBe(OTHER);
    expect(accountScopeIdentity()).not.toBe(scope);
  });

  test('forced refresh during a same-organization token read still rotates the rejected token', async () => {
    const scoped = scopedOrganizationAccessToken(SOURCE);
    await Promise.resolve();
    await Promise.resolve();
    const refreshed = refreshAccount();
    await scoped;
    expect((await refreshed)?.refreshToken).toBe('rt_1');
    expect(calls.map((request) => request.path)).toEqual(['/api/auth/refresh']);
  });

  test('a superseded legacy query or forced refresh cannot sign out a successful organization switch', async () => {
    installTestAccount({ org_id: SOURCE, exp: 1 });
    const held = hold((request) => request.path.endsWith('/refresh'));
    const switching = switchOrganization(OTHER);
    const response = await held.started;
    const query = outcome(call({ method: 'GET', base: 'https://source.example/api/probe' }));
    const forced = outcome(refreshAccount());
    held.release(Response.json(response));
    await switching;
    for (const error of await Promise.all([query, forced])) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AuthError);
    }
    expect(activeAccount()?.organization).toBe(OTHER);
    expect(calls.map((request) => request.path)).toEqual(['/api/auth/refresh', '/api/auth/switch']);
  });

  test('a queued dashboard read cannot capture the newly selected organization as its source', async () => {
    const held = hold((call) => call.body.organization === OTHER);
    const switching = switchOrganization(OTHER);
    const response = await held.started;
    const dashboard = outcome(scopedOrganizationAccessToken(TARGET));
    held.release(Response.json(response));
    await switching;
    expect(await dashboard).toBeInstanceOf(Error);
    expect(switches()).toEqual([OTHER]);
    expect(activeAccount()?.organization).toBe(OTHER);
  });

  test('one cancelled singleflight subscriber cannot interrupt rotation or another subscriber', async () => {
    const held = hold((call) => call.body.organization === TARGET);
    const abort = new AbortController();
    const cancelled = outcome(scopedOrganizationAccessToken(TARGET, { signal: abort.signal }));
    const retained = scopedOrganizationAccessToken(TARGET);
    const response = await held.started;
    abort.abort();
    expect(calls[0]?.init.signal?.aborted).toBe(false);
    held.release(Response.json(response));
    expect(await cancelled).toHaveProperty('name', 'AbortError');
    expect(await retained).toBe(testToken({ org_id: TARGET, role: 'member' }));
    expect(switches()).toEqual([TARGET, SOURCE]);
    expect(activeAccount()?.refreshToken).toBe('rt_2');
  });

  test('already cancelled and signed-out reads send no requests', async () => {
    await expect(scopedOrganizationAccessToken(TARGET, { signal: AbortSignal.abort() })).rejects.toThrow();
    clearAccount();
    await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow('Log in');
    expect(calls).toHaveLength(0);
  });

  test('expired or mismatched destination tokens are refused only after source restoration', async () => {
    for (const claims of [{ org_id: TARGET, exp: 1 }, { org_id: SOURCE }, { org_id: TARGET, sub: 'other_user' }]) {
      transform = (call, account) => Promise.resolve(Response.json(call.body.organization === TARGET ? { ...account, accessToken: testToken(claims) } : account));
      await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow();
      expect(activeAccount()?.organization).toBe(SOURCE);
    }
    expect(switches()).toEqual([TARGET, SOURCE, TARGET, SOURCE, TARGET, SOURCE]);
    expect(tokenExpiry('e30.eyJleHAiOjFlMzA5fQ.sig')).toBeNull();
    expect(tokenExpiring('e30.eyJleHAiOjFlMzA5fQ.sig')).toBe(true);
  });

  test('malformed destination fields still restore and do not fail source refresh waiters', async () => {
    const scope = accountScopeIdentity();
    const held = hold((call) => call.body.organization === TARGET);
    const pending = outcome(scopedOrganizationAccessToken(TARGET));
    const response = await held.started;
    const refreshed = refreshAccount();
    held.release(Response.json({ refreshToken: response.refreshToken, user: null }));
    expect((await refreshed)?.refreshToken).toBe('rt_2');
    expect(await pending).toBeInstanceOf(Error);
    expect(switches()).toEqual([TARGET, SOURCE]);
    expect(accountScopeIdentity()).toBe(scope);
  });

  test('a session with no source organization is refused before any rotation', async () => {
    storeAccount({ ...installTestAccount(), organization: null, accessToken: testToken({ org_id: null }) });
    await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow('source organization');
    expect(calls).toEqual([]);
    expect(activeAccount()?.organization).toBeNull();
  });

  test('failed source refresh never falls back to its old token or begins a destination switch', async () => {
    installTestAccount({ org_id: SOURCE, exp: 1 });
    transform = () => Promise.resolve(Response.json({}, { status: 401 }));
    await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow('refresh your session');
    expect(switches()).toEqual([]);
    expect(activeAccount()).toBeNull();
  });

  test('failed source restoration signs out without returning a destination or source bearer', async () => {
    transform = (call, account) => Promise.resolve(call.body.organization === SOURCE ? Response.json({}, { status: 503 }) : Response.json(account));
    await expect(scopedOrganizationAccessToken(TARGET)).rejects.toThrow('Sign in again');
    expect(activeAccount()).toBeNull();
    expect(persisted).toHaveLength(1);
  });
});

describe('account scope guards across asynchronous auth work', () => {
  test('scope listeners ignore refresh and restoration, then fire for switch, relogin and logout', async () => {
    const changes: number[] = [];
    const unsubscribe = subscribeAccountScope(() => { changes.push(accountScopeIdentity()); });
    try {
      const scope = accountScopeIdentity();
      loadAccount();
      await refreshAccount();
      loadAccount();
      await scopedOrganizationAccessToken(TARGET);
      loadAccount();
      expect(changes).toEqual([]);
      expect(accountScopeIdentity()).toBe(scope);
      await switchOrganization(OTHER);
      installTestAccount({ org_id: OTHER, role: 'member' });
      await logoutAccount();
      expect(changes).toHaveLength(3);
      expect(new Set(changes).size).toBe(3);
    } finally { unsubscribe(); }
    clearAccount();
    expect(changes).toHaveLength(3);
  });

  for (const action of ['logout', 'relogin', 'organization'] as const) {
    test(`late destination responses still restore, without overwriting ${action}`, async () => {
      const held = hold((call) => call.body.organization === TARGET);
      const pending = outcome(scopedOrganizationAccessToken(TARGET));
      const response = await held.started;
      if (action === 'logout') await logoutAccount();
      else installTestAccount({ org_id: action === 'organization' ? OTHER : SOURCE, sid: 'new_session', role: 'member' });
      const replacement = activeAccount();
      const scope = accountScopeIdentity();
      held.release(Response.json(response));
      expect(await pending).toBeInstanceOf(Error);
      expect(switches()).toEqual([TARGET, SOURCE]);
      expect(activeAccount()).toBe(replacement);
      expect(accountScopeIdentity()).toBe(scope);
      expect(persisted).toHaveLength(action === 'logout' ? 1 : 2);
    });
  }

  test('a late restoration failure cannot clear a replacement session', async () => {
    const held = hold((call) => call.body.organization === SOURCE);
    const pending = outcome(scopedOrganizationAccessToken(TARGET));
    await held.started;
    const replacement = installTestAccount({ org_id: SOURCE, sid: 'new_session' });
    held.release(Response.json({}, { status: 403 }));
    expect(await pending).toBeInstanceOf(Error);
    expect(activeAccount()).toBe(replacement);
  });

  for (const failing of [false, true]) {
    test(`late refresh ${failing ? 'failure' : 'success'} cannot overwrite relogin or revive logout`, async () => {
      const held = hold((call) => call.path.endsWith('/refresh'));
      const refreshed = outcome(refreshAccount());
      const response = await held.started;
      const queued = outcome(scopedOrganizationAccessToken(TARGET));
      await logoutAccount();
      const replacement = failing ? installTestAccount({ org_id: SOURCE, sid: 'new_session' }) : null;
      held.release(failing ? Response.json({}, { status: 401 }) : Response.json(response));
      expect(await refreshed).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      expect(activeAccount()).toBe(replacement);
      expect(switches()).toEqual([]);
    });
  }

  test('late explicit switching does not replace a new login', async () => {
    const held = hold((call) => call.body.organization === OTHER);
    const switched = outcome(switchOrganization(OTHER));
    const response = await held.started;
    const replacement = installTestAccount({ org_id: SOURCE, sid: 'new_session' });
    held.release(Response.json(response));
    expect(await switched).toBeInstanceOf(Error);
    expect(activeAccount()).toBe(replacement);
  });

  test('late handoff cannot reauthenticate after logout even while already signed out', async () => {
    clearAccount();
    const held = hold((call) => call.path.endsWith('/exchange'));
    const exchanged = outcome(exchangeHandoff('fixture_handoff'));
    const response = await held.started;
    await logoutAccount();
    held.release(Response.json(response));
    expect(await exchanged).toBeInstanceOf(Error);
    expect(activeAccount()).toBeNull();
  });

  test('a late organization listing cannot start a copy after the same user relogs in', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    globalThis.fetch = (() => { started.resolve(); return response.promise; }) as unknown as typeof fetch;
    const pending = outcome(fetchOrganizations());
    await started.promise;
    const replacement = installTestAccount({ org_id: SOURCE, sid: 'new_session' });
    response.resolve(Response.json({ organizations: [{ id: TARGET, role: 'admin' }] }));
    expect(await pending).toBeInstanceOf(Error);
    expect(activeAccount()).toBe(replacement);
  });

  test('account storage rejects a stale refresh identity directly', () => {
    const scope = accountScopeIdentity();
    const original = activeAccount();
    clearAccount();
    if (original === null) throw new Error('Fixture account missing');
    expect(() => { storeAccount(original, scope); }).toThrow('account changed');
    expect(activeAccount()).toBeNull();
  });
});
