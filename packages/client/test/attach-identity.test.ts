import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AttachLifetime } from '../src/api/attach-lifetime.js';
import { cancelAttachSession, pollAttachSession, submitAttachStep } from '../src/api/attach-session.js';
import { startAttach } from '../src/api/attach.js';
import { refreshAccount } from '../src/api/auth.js';
import { finishReturn, rememberSignIn } from '../src/api/sign-in-return.js';
import { accountIdentity, activeAccount, clearAccount, storeAccount, type Account, type AccountIdentity } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue, readItem, writeItem } from '../src/platform.js';
import { installTestAccount, testToken } from './account-fixture.js';

const BASE = 'https://original-box.invalid/api/agents';
const PENDING = { attachId: 'attach', station: 'gmail', status: 'pending', step: 'browser' };
const realFetch = globalThis.fetch;
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const seen: { url: string; bearer: string | null }[] = [];
let original: Account;
let identity: AccountIdentity;
let respond: (url: string) => Promise<Response>;

beforeEach(() => {
  let queued: Promise<void> = Promise.resolve();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    document: {}, addEventListener: () => undefined, removeEventListener: () => undefined,
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request: <T>(name: string, run: () => Promise<T>): Promise<T> => {
      expect(name).toBe('metro.account');
      const pending = queued.then(run);
      queued = pending.then(() => undefined, () => undefined);
      return pending;
    },
  } } });
  configurePlatform({ kv: memoryKeyValue() });
  original = installTestAccount();
  const captured = accountIdentity();
  if (captured === null) throw new Error('Missing test identity');
  identity = captured;
  seen.length = 0;
  respond = () => Promise.resolve(Response.json(PENDING));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, bearer: new Headers(init?.headers).get('authorization') });
    return respond(url);
  }) as typeof fetch;
});

afterEach(() => {
  if (realWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', realWindow);
  if (realNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
  else Object.defineProperty(globalThis, 'navigator', realNavigator);
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue() });
});

function changed(part: 'user' | 'organization' | 'session'): Account {
  const user = part === 'user' ? 'user_other' : original.user.id;
  const organization = part === 'organization' ? 'org_other' : original.organization;
  return {
    ...original,
    user: { ...original.user, id: user },
    organization,
    accessToken: testToken({ sub: user, org_id: organization, sid: part === 'session' ? 'session_other' : 'session_1' }),
    refreshToken: 'refresh_other',
  };
}

function remember(): void {
  rememberSignIn({ state: 'state', agentsBase: BASE, agentId: 'agent', attachId: 'attach', backHash: '#/channels', startedAt: Date.now(), identity });
}

const returned = { kind: 'code', code: 'synthetic-code', state: 'state' } as const;

const operations = [
  () => startAttach('agent', 'gmail', {}, BASE, identity),
  () => pollAttachSession('agent', 'attach', BASE, identity),
  () => submitAttachStep('agent', 'attach', { code: 'synthetic' }, BASE, identity),
  () => cancelAttachSession('agent', 'attach', BASE, identity),
];

describe('attachment initiating account boundary', () => {
  for (const part of ['user', 'organization', 'session'] as const) {
    test(`every attach request and callback refuses a changed ${part}`, async () => {
      remember();
      storeAccount(changed(part));
      for (const operation of operations) await expect(operation()).rejects.toThrow('account changed');
      expect(await finishReturn(returned)).toMatchObject({ ok: false, message: expect.stringContaining('account changed') });
      expect(seen).toEqual([]);
    });
  }

  test('logout and a storage-only account switch refuse before refresh or fetch', async () => {
    for (const next of [JSON.stringify(changed('user')), null]) {
      storeAccount(original);
      writeItem('metro.account', next);
      for (const operation of operations) await expect(operation()).rejects.toThrow('account changed');
    }
    clearAccount();
    for (const operation of operations) await expect(operation()).rejects.toThrow('account changed');
    expect(seen).toEqual([]);
  });

  test('an identity missing its WorkOS session never starts', async () => {
    installTestAccount({ sid: undefined });
    await expect(new AttachLifetime('agent', BASE).start('gmail', {})).rejects.toThrow('account changed');
    expect(seen).toEqual([]);
  });

  test('closing after an account switch removes local pending state without sending the new bearer', async () => {
    const life = new AttachLifetime('agent', BASE);
    await life.start('gmail', {});
    remember();
    storeAccount(changed('user'));
    await expect(life.close()).rejects.toThrow('account changed');
    expect(readItem('metro.outlook.pending')).toBeNull();
    expect(seen).toEqual([{ url: `${BASE}/agent/accounts/start`, bearer: `Bearer ${original.accessToken}` }]);
  });

  test('a late start after close and account switch cannot cancel with the new bearer', async () => {
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    respond = () => { requested.resolve(); return response.promise; };
    const life = new AttachLifetime('agent', BASE);
    const starting = life.start('gmail', {});
    await requested.promise;
    await life.close();
    storeAccount(changed('session'));
    response.resolve(Response.json(PENDING));
    await expect(starting).rejects.toThrow('account changed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bearer).toBe(`Bearer ${original.accessToken}`);
  });

  test('switching during token lookup prevents the first request', async () => {
    const starting = startAttach('agent', 'gmail', {}, BASE, identity);
    storeAccount(changed('user'));
    await expect(starting).rejects.toThrow('account changed');
    expect(seen).toEqual([]);
  });

  test('a 401 after an account switch cannot refresh or retry', async () => {
    respond = () => {
      storeAccount(changed('user'));
      return Promise.resolve(Response.json({ error: 'expired' }, { status: 401 }));
    };
    await expect(pollAttachSession('agent', 'attach', BASE, identity)).rejects.toThrow('account changed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bearer).toBe(`Bearer ${original.accessToken}`);
  });

  test('callback settlement refuses a switched account before its next poll', async () => {
    remember();
    const finishing = finishReturn(returned);
    await new Promise((resolve) => setTimeout(resolve, 20));
    storeAccount(changed('organization'));
    expect(await finishing).toMatchObject({ ok: false, message: expect.stringContaining('account changed') });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${BASE}/agent/accounts/attach/step`);
  });
});

describe('refresh races during an attachment', () => {
  for (const status of [200, 400]) {
    for (const storageOnly of [false, true]) {
      test(`stale refresh ${String(status)} cannot overwrite or clear a ${storageOnly ? 'stored' : 'loaded'} new account`, async () => {
        const response = Promise.withResolvers<Response>();
        const requested = Promise.withResolvers<void>();
        respond = () => { requested.resolve(); return response.promise; };
        const refreshing = refreshAccount();
        await requested.promise;
        const next = changed('user');
        if (storageOnly) writeItem('metro.account', JSON.stringify(next));
        else storeAccount(next);
        const stored = readItem('metro.account');
        response.resolve(Response.json(status === 200 ? { ...original, refreshToken: 'rotated' } : { error: 'refused' }, { status }));
        await expect(refreshing).rejects.toThrow('account changed');
        expect(readItem('metro.account')).toBe(stored);
        expect(activeAccount()).toMatchObject(next);
      });
    }
  }

  test('a storage-only organization switch stays protected when the refresh token did not rotate', async () => {
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    respond = () => { requested.resolve(); return response.promise; };
    const refreshing = refreshAccount();
    await requested.promise;
    const next = { ...changed('organization'), refreshToken: original.refreshToken };
    writeItem('metro.account', JSON.stringify(next));
    response.resolve(Response.json({ ...original, refreshToken: 'rotated' }));
    await expect(refreshing).rejects.toThrow('account changed');
    expect(readItem('metro.account')).toBe(JSON.stringify(next));
    expect(activeAccount()).toMatchObject(next);
  });

  test('switching while an expiring token refreshes cannot start on the original box', async () => {
    original = installTestAccount({ exp: 1 });
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    respond = () => { requested.resolve(); return response.promise; };
    const starting = startAttach('agent', 'gmail', {}, BASE, identity);
    await requested.promise;
    const next = changed('user');
    storeAccount(next);
    response.resolve(Response.json({ ...original, accessToken: testToken(), refreshToken: 'rotated' }));
    await expect(starting).rejects.toThrow();
    expect(activeAccount()).toBe(next);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toEndWith('/api/auth/refresh');
    expect(seen[0]?.bearer).toBeNull();
  });

  test('a same-session refresh is accepted and retries with its rotated bearer', async () => {
    const token = testToken({ exp: 4_202_444_800 });
    respond = (url) => Promise.resolve(url.endsWith('/refresh')
      ? Response.json({ ...original, accessToken: token, refreshToken: 'rotated' })
      : seen.length === 1 ? Response.json({}, { status: 401 }) : Response.json(PENDING));
    expect((await pollAttachSession('agent', 'attach', BASE, identity)).attachId).toBe('attach');
    expect(seen.map((call) => call.bearer)).toEqual([`Bearer ${original.accessToken}`, null, `Bearer ${token}`]);
  });
});
