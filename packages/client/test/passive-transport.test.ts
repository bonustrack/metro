import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { callBearer } from '../src/api/client.js';
import { DASHBOARD_SINCE, dashboardSource } from '../src/api/dashboard-source.js';
import { dashboardKey, emptyReading, type DashboardRow } from '../src/api/dashboard.js';
import { accountScopeIdentity, clearAccount } from '../src/auth/account.js';
import { configurePlatform, fetchNoRedirect, memoryKeyValue } from '../src/platform.js';
import { installTestAccount } from './account-fixture.js';

const network: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = globalThis;
const browserFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
const nativeRequests: Request[] = [];
let activeRequests = 0;
let restore = (): void => undefined;

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), fetchNoRedirect: browserFetch });
  installTestAccount({ org_id: 'org-passive', role: 'member' });
  nativeRequests.length = 0;
  activeRequests = 0;
});

afterEach(() => {
  restore();
  restore = () => undefined;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue(), fetchNoRedirect: browserFetch });
});

function nativeTransport(redirectPath: string): void {
  const unsafe = spyOn(network, 'fetch').mockImplementation(() => {
    activeRequests += 1;
    return Promise.resolve(Response.json({ followed: true }));
  });
  restore = () => { unsafe.mockRestore(); };
  configurePlatform({ fetchNoRedirect: (url, init) => {
    const request = new Request(url, init);
    nativeRequests.push(request);
    const path = new URL(url).pathname;
    if (path === redirectPath) {
      if (request.redirect === 'error') return Promise.reject(new TypeError('redirect refused'));
      activeRequests += 1;
      return Promise.resolve(Response.json({ followed: true }));
    }
    return Promise.resolve(Response.json({ mode: 'local', owner: 'org-passive', version: DASHBOARD_SINCE }));
  } });
}

function row(): DashboardRow {
  const agent = { id: 'passive', host: 'passive.example.invalid', name: 'Passive', slug: null, avatar: null };
  return {
    key: dashboardKey('org-passive', agent), agent,
    organization: { id: 'org-passive', name: 'Passive', slug: null, role: 'member', agents: [agent] },
    mode: emptyReading(), session: emptyReading(), model: emptyReading(),
  };
}

test('web transport forces redirect refusal and preserves headers and cancellation', async () => {
  const signal = new AbortController().signal;
  const fetched = spyOn(network, 'fetch').mockResolvedValue(Response.json({ ok: true }));
  restore = () => { fetched.mockRestore(); };
  const response = await fetchNoRedirect('https://passive.example.invalid/api/mode', {
    method: 'GET', signal, headers: { accept: 'application/json' }, redirect: 'follow',
  });
  expect(await response.json()).toEqual({ ok: true });
  expect(fetched).toHaveBeenCalledWith('https://passive.example.invalid/api/mode', {
    method: 'GET', signal, headers: { accept: 'application/json' }, redirect: 'error',
  });
});

test('native public mode refuses redirects without reaching the redirect-ignoring global fetch', async () => {
  nativeTransport('/api/mode');
  const source = dashboardSource(accountScopeIdentity(), () => true);
  await expect(source.model(row(), 'fixture-token', new AbortController().signal)).rejects.toThrow('redirect refused');
  expect(nativeRequests.map((request) => [new URL(request.url).pathname, request.headers.get('authorization')])).toEqual([
    ['/api/mode', null],
  ]);
  expect(activeRequests).toBe(0);
});

test.each(['model', 'session'] as const)('native %s snapshots refuse redirects before any active endpoint is followed', async (kind) => {
  const path = kind === 'model' ? '/api/model/snapshot' : '/api/claude/session/snapshot';
  nativeTransport(path);
  const source = dashboardSource(accountScopeIdentity(), () => true);
  await expect(source[kind](row(), 'fixture-token', new AbortController().signal)).rejects.toThrow('Failed to reach Metro');
  expect(nativeRequests.map((request) => [new URL(request.url).pathname, request.headers.get('authorization'), request.redirect])).toEqual([
    ['/api/mode', null, 'error'], [path, 'Bearer fixture-token', 'error'],
  ]);
  expect(activeRequests).toBe(0);
});

test('explicit native bearer reads cannot override the redirect-safe transport', async () => {
  nativeTransport('/api/model/snapshot');
  const signal = new AbortController().signal;
  await expect(callBearer({ method: 'GET', base: 'https://passive.example.invalid/api/model/snapshot', signal, redirect: 'follow' }, 'fixture-token')).rejects.toThrow('Failed to reach Metro');
  expect(nativeRequests).toHaveLength(1);
  expect(nativeRequests[0]?.redirect).toBe('error');
  expect(nativeRequests[0]?.headers.get('authorization')).toBe('Bearer fixture-token');
  expect(activeRequests).toBe(0);
});
