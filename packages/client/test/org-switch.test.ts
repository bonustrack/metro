import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accessToken, fetchOrganizations, logoutAccount, refreshAccount, switchOrganization } from '../src/api/auth.js';
import { AuthError, call } from '../src/api/client.js';
import { AccountChangedError, accountScopeIdentity, activeAccount, clearAccount, shareActiveAccount, storeAccount, subscribeAccountScope, type Account } from '../src/auth/account.js';
import { forOrganization, openOrganization } from '../src/auth/org-route.js';
import { configurePlatform, HOSTED_API, memoryKeyValue, type KeyValue } from '../src/platform.js';
import { testToken } from './account-fixture.js';

const STAGE = 'org_01STAGELABS0';
const SNAPSHOT = 'org_01SNAPSHOT00';
const MCI = 'org_01MCIGROUP00';
const ORGS = [
  { id: STAGE, slug: 'stage-labs', name: 'Stage Labs' },
  { id: SNAPSHOT, slug: 'snapshot', name: 'Snapshot' },
  { id: MCI, slug: 'mci', name: 'MCI' },
];
const USER = { id: 'user_1', email: 'less@example.com', name: 'Less', picture: null };
const realFetch = globalThis.fetch;
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

interface Seen { path: string; organization: unknown; refreshToken: unknown; bearer: string | null }
interface Held { started: Promise<void>; release: () => void }

let kv: KeyValue;
let tab: KeyValue;
let seen: Seen[];
let live: Set<string>;
let sequence: number;
let holds: Map<string, { arrived: () => void; released: Promise<void> }>;
let refuse: (path: string, body: Record<string, unknown>) => Response | null;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function hold(path: string): Held {
  const started = deferred();
  const released = deferred();
  holds.set(path, { arrived: started.resolve, released: released.promise });
  return { started: started.promise, release: released.resolve };
}

const expiringSoon = (): number => Math.floor(Date.now() / 1000) + 30;

function accountFor(organization: string, refreshToken: string, claims: Record<string, unknown> = {}): Account {
  const row = ORGS.find((org) => org.id === organization);
  return { accessToken: testToken({ org_id: organization, role: 'admin', ...claims }), refreshToken, organization, organizationName: row?.name ?? null, organizationSlug: row?.slug ?? null, role: 'admin', user: USER };
}

function signIn(organization = STAGE, claims: Record<string, unknown> = {}): Account {
  const account = accountFor(organization, 'rt_0', claims);
  live = new Set(['rt_0']);
  storeAccount(account);
  return account;
}

function answer(path: string, body: Record<string, unknown>): Response {
  if (path === '/api/auth/organizations') return Response.json({ organizations: ORGS });
  if (path === '/api/auth/logout') return Response.json({ ok: true });
  if (path !== '/api/auth/refresh' && path !== '/api/auth/switch') return Response.json({ subject: USER.id });
  const organization = typeof body.organization === 'string' ? body.organization : STAGE;
  if (!ORGS.some((org) => org.id === organization)) return Response.json({ error: 'you are not a member of that organization' }, { status: 404 });
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (!live.delete(refreshToken)) return Response.json({ error: 'the session has ended, sign in again' }, { status: 401 });
  sequence += 1;
  const next = `rt_${String(sequence)}`;
  live.add(next);
  return Response.json(accountFor(organization, next));
}

beforeEach(() => {
  kv = memoryKeyValue();
  tab = memoryKeyValue();
  configurePlatform({ kv, tabKv: tab, apiBase: 'https://auth.example' });
  clearAccount();
  seen = [];
  sequence = 0;
  holds = new Map();
  refuse = () => null;
  signIn();
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    seen.push({ path, organization: body.organization, refreshToken: body.refreshToken, bearer: new Headers(init.headers).get('authorization') });
    const gate = holds.get(path);
    gate?.arrived();
    await gate?.released;
    return refuse(path, body) ?? answer(path, body);
  }) as typeof fetch;
});

afterEach(() => {
  if (realWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', realWindow);
  if (realNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
  else Object.defineProperty(globalThis, 'navigator', realNavigator);
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue(), apiBase: HOSTED_API });
});

const rotations = (): string[] => seen.filter((call) => call.path === '/api/auth/switch' || call.path === '/api/auth/refresh').map((call) => `${call.path.split('/').at(-1) ?? ''} ${String(call.organization)} ${String(call.refreshToken)}`);
const signedOut = (): Seen[] => seen.filter((call) => call.path === '/api/auth/logout');
const outcome = (pending: Promise<unknown>): Promise<unknown> => pending.catch((error: unknown) => error);

describe('switching organizations on the page', () => {
  test('a second switch started while the first is in flight lands on the second one, with no error', async () => {
    const switching = hold('/api/auth/switch');
    let first = true;
    const toSnapshot = openOrganization('snapshot', () => first);
    await switching.started;
    first = false;
    const toMci = openOrganization('mci');
    switching.release();
    expect(await toSnapshot).toEqual({ kind: 'stale' });
    expect(await toMci).toEqual({ kind: 'open', organization: MCI });
    expect(activeAccount()?.organization).toBe(MCI);
    expect(rotations()).toEqual([`switch ${SNAPSHOT} rt_0`, `switch ${MCI} rt_1`]);
  });

  test('A to B and quickly back to A ends on A, and the way back needs no new rotation', async () => {
    const switching = hold('/api/auth/switch');
    let onSnapshot = true;
    const toSnapshot = openOrganization('snapshot', () => onSnapshot);
    await switching.started;
    onSnapshot = false;
    switching.release();
    expect(await toSnapshot).toEqual({ kind: 'stale' });
    expect(activeAccount()?.organization).toBe(SNAPSHOT);
    expect(await openOrganization('stage-labs')).toEqual({ kind: 'open', organization: STAGE });
    expect(activeAccount()?.organization).toBe(STAGE);
    expect(activeAccount()?.refreshToken).toBe('rt_1');
    expect(rotations()).toEqual([`switch ${SNAPSHOT} rt_0`]);
    expect(await openOrganization('snapshot')).toEqual({ kind: 'open', organization: SNAPSHOT });
    expect(rotations()).toEqual([`switch ${SNAPSHOT} rt_0`]);
  });

  test('requests made while a switch is in flight keep the old token or are dropped, never mixed and never signed out', async () => {
    const before = activeAccount()?.accessToken ?? '';
    const switching = hold('/api/auth/switch');
    const opening = openOrganization('snapshot');
    await switching.started;
    expect(await accessToken()).toBe(before);
    expect(await call({ method: 'GET', base: 'https://stage-box.example/api/session' })).toEqual({ subject: USER.id });
    expect(seen.at(-1)?.bearer).toBe(`Bearer ${before}`);
    const forced = outcome(refreshAccount());
    switching.release();
    expect(await opening).toEqual({ kind: 'open', organization: SNAPSHOT });
    const dropped = await forced;
    expect(dropped).toBeInstanceOf(AccountChangedError);
    expect(dropped).not.toBeInstanceOf(AuthError);
    expect(await accessToken()).toBe(accountFor(SNAPSHOT, '').accessToken);
    expect(rotations()).toEqual([`switch ${SNAPSHOT} rt_0`]);
    expect(signedOut()).toEqual([]);
  });

  test('a refresh in flight when the switch starts finishes first and hands the switch a fresh refresh token', async () => {
    signIn(STAGE, { exp: expiringSoon() });
    const refreshing = hold('/api/auth/refresh');
    const early = accessToken();
    await refreshing.started;
    const opening = openOrganization('snapshot');
    refreshing.release();
    expect(await early).toBe(accountFor(STAGE, '').accessToken);
    expect(await opening).toEqual({ kind: 'open', organization: SNAPSHOT });
    expect(rotations()).toEqual([`refresh ${STAGE} rt_0`, `switch ${SNAPSHOT} rt_1`]);
  });

  test('the organization list asked for before a switch still answers after it', async () => {
    const listing = hold('/api/auth/organizations');
    const rows = fetchOrganizations();
    await listing.started;
    await switchOrganization(SNAPSHOT);
    listing.release();
    expect((await rows).map((row) => row.slug)).toEqual(['stage-labs', 'snapshot', 'mci']);
  });

  test('a read bound to an organization is dropped once the tab moved to another one', async () => {
    const listing = hold('/api/auth/organizations');
    const read = outcome(forOrganization(STAGE, fetchOrganizations));
    await listing.started;
    await switchOrganization(SNAPSHOT);
    listing.release();
    expect(await read).toBeInstanceOf(AccountChangedError);
    await expect(forOrganization(STAGE, fetchOrganizations)).rejects.toBeInstanceOf(AccountChangedError);
    expect(seen.filter((request) => request.path === '/api/auth/organizations')).toHaveLength(1);
  });

  test('not being a member, or WorkOS being down, is reported and keeps the session', async () => {
    expect(await openOrganization('elsewhere')).toEqual({ kind: 'refused', message: 'you are not a member of that organization' });
    expect(await openOrganization('org_01NOTMEMBER0')).toEqual({ kind: 'refused', message: 'you are not a member of that organization' });
    refuse = (path) => (path === '/api/auth/switch' ? Response.json({ error: 'WorkOS is not answering' }, { status: 503 }) : null);
    expect(await openOrganization('snapshot')).toEqual({ kind: 'failed', message: 'WorkOS is not answering' });
    expect(activeAccount()).toMatchObject({ organization: STAGE, refreshToken: 'rt_0' });
    expect(signedOut()).toEqual([]);
  });

  test('only a real sign-in change ends an open on the login page', async () => {
    const listing = hold('/api/auth/organizations');
    const opening = openOrganization('snapshot');
    await listing.started;
    await logoutAccount();
    listing.release();
    expect(await opening).toEqual({ kind: 'signed-out' });
    signIn(STAGE, { exp: expiringSoon() });
    live.clear();
    expect(await openOrganization('snapshot')).toEqual({ kind: 'signed-out' });
    expect(activeAccount()).toBeNull();
  });
});

function browserTab(): { changed: () => void } {
  let tail: Promise<void> = Promise.resolve();
  const callbacks = new Set<(event: { key: string }) => void>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { document: {},
    addEventListener: (_type: string, callback: (event: { key: string }) => void) => callbacks.add(callback),
    removeEventListener: (_type: string, callback: (event: { key: string }) => void) => callbacks.delete(callback),
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request: <T>(_name: string, run: () => Promise<T>): Promise<T> => {
      const pending = tail.then(run);
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  } } });
  activeAccount();
  return { changed: () => { for (const callback of callbacks) callback({ key: 'metro.account' }); } };
}

function otherTabWrites(organization: string, changes: Record<string, unknown> = {}): string {
  const body = JSON.parse(kv.getItem('metro.account') ?? '{}') as Record<string, unknown>;
  const consumed = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  live.delete(consumed);
  const refreshToken = `rt_other_${organization}`;
  live.add(refreshToken);
  kv.setItem('metro.account', JSON.stringify({ ...body, ...accountFor(organization, refreshToken), ...changes }));
  return refreshToken;
}

describe('two tabs of one browser', () => {
  test('another tab switching does not move this tab, change its scope or reuse a refresh token', async () => {
    const browser = browserTab();
    const mine = activeAccount();
    const scope = accountScopeIdentity();
    let notified = 0;
    const unsubscribe = subscribeAccountScope(() => { notified += 1; });
    try {
      const rotated = otherTabWrites(SNAPSHOT);
      browser.changed();
      expect(activeAccount()).toMatchObject({ organization: STAGE, accessToken: mine?.accessToken, refreshToken: rotated });
      expect(accountScopeIdentity()).toBe(scope);
      expect(notified).toBe(0);
      expect((await refreshAccount())?.organization).toBe(STAGE);
      expect(rotations()).toEqual([`refresh ${STAGE} ${rotated}`]);
      expect(notified).toBe(0);
    } finally { unsubscribe(); }
  });

  test('this tab opens mci while another tab switches, with no error and on the newest refresh token', async () => {
    const browser = browserTab();
    const listing = hold('/api/auth/organizations');
    const opening = openOrganization('mci');
    await listing.started;
    const rotated = otherTabWrites(SNAPSHOT);
    browser.changed();
    listing.release();
    expect(await opening).toEqual({ kind: 'open', organization: MCI });
    expect(rotations()).toEqual([`switch ${MCI} ${rotated}`]);
    expect(activeAccount()?.organization).toBe(MCI);
  });

  test('a switch in this tab is remembered for this tab only, bound to the session', async () => {
    browserTab();
    await switchOrganization(SNAPSHOT);
    const record = JSON.parse(kv.getItem('metro.account') ?? '{}') as Record<string, unknown>;
    const pinned = JSON.parse(tab.getItem('metro.account.tab') ?? '{}') as Record<string, unknown>;
    expect(pinned).toMatchObject({ scope: record.sessionScope, organization: SNAPSHOT, accessToken: activeAccount()?.accessToken });
  });

  test('another tab signing in again moves this tab to the new session', () => {
    const browser = browserTab();
    const scope = accountScopeIdentity();
    otherTabWrites(MCI, { sessionScope: 'a_new_sign_in' });
    browser.changed();
    expect(activeAccount()?.organization).toBe(MCI);
    expect(accountScopeIdentity()).not.toBe(scope);
  });

  test('sharing this tab makes its organization the one a new tab opens on, with the newest refresh token', async () => {
    const browser = browserTab();
    const rotated = otherTabWrites(SNAPSHOT);
    browser.changed();
    await shareActiveAccount();
    expect(JSON.parse(kv.getItem('metro.account') ?? '{}')).toMatchObject({ organization: STAGE, refreshToken: rotated });
    expect(activeAccount()?.organization).toBe(STAGE);
  });
});
