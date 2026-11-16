import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createLoginLink, fetchOrganizationUsage, fetchUsers, isOperator, removeLoginLink, restartAgentIn } from '../src/api/admin.js';
import { clearAccount, type Account } from '../src/auth/account.js';
import { configurePlatform, HOSTED_API, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';

const API = 'https://api.example';
const HOST = 'metro-abc123.tail1234.ts.net';
const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  method: string;
  authorization: string | null;
}

let sent: Sent[] = [];

function answer(body: unknown, status = 200): void {
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', authorization: new Headers(init.headers).get('authorization') });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

let account: Account;

beforeEach(() => {
  configurePlatform({ apiBase: API, kv: memoryKeyValue() });
  sent = [];
  account = installTestAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue(), apiBase: HOSTED_API });
});

describe('the operator reading other organizations', () => {
  test('the resource readings of one organization come from metro.box with that organization signed in', async () => {
    answer({ servers: { emma0000001: { cpu: 12, memory: 48, disk: null }, bad: 'x' } });
    expect(await fetchOrganizationUsage(TEST_ORGANIZATION)).toEqual({ emma0000001: { cpu: 12, memory: 48, disk: null } });
    expect(sent).toEqual([{ url: `${API}/api/servers/usage`, method: 'GET', authorization: `Bearer ${account.accessToken}` }]);
  });

  test('a restart goes to the agent itself, and a refusal from the box is an error', async () => {
    answer({ ok: true });
    await restartAgentIn(TEST_ORGANIZATION, HOST);
    expect(sent).toEqual([{ url: `https://${HOST}/api/restart`, method: 'POST', authorization: `Bearer ${account.accessToken}` }]);
    answer({ error: 'admin only' }, 403);
    let refused = '';
    await restartAgentIn(TEST_ORGANIZATION, HOST).catch((err: unknown) => { refused = err instanceof Error ? err.message : ''; });
    expect(refused).toBe('admin only');
  });

  test('only the operator account opens the admin pages', () => {
    expect(isOperator(account)).toBe(true);
    expect(isOperator({ ...account, user: { ...account.user, email: 'less@anderra.ch' } })).toBe(false);
    expect(isOperator(null)).toBe(false);
  });
});

describe('login links on the operator\'s user rows', () => {
  const LINK_URL = `https://metro.box/#/auth/link/${'a'.repeat(43)}`;

  test('a row reads its link, and a row from an older api, or a broken one, has none', async () => {
    answer({
      users: [
        { id: 'user_1', email: 'one@example.invalid', loginLink: { id: 'lnk', createdAt: 1_700_000_000_000, lastUsedAt: null } },
        { id: 'user_2', loginLink: { id: 'lnk2', createdAt: 1_700_000_000_000, lastUsedAt: 1_700_000_100_000 } },
        { id: 'user_3' },
        { id: 'user_4', loginLink: null },
        { id: 'user_5', loginLink: { id: 'lnk5', createdAt: 'yesterday' } },
      ],
    });
    expect((await fetchUsers()).map((user) => user.loginLink)).toEqual([
      { id: 'lnk', createdAt: 1_700_000_000_000, lastUsedAt: null },
      { id: 'lnk2', createdAt: 1_700_000_000_000, lastUsedAt: 1_700_000_100_000 },
      null,
      null,
      null,
    ]);
  });

  test('making a link answers it once, and removing it is a delete', async () => {
    answer({ id: 'lnk', url: LINK_URL, createdAt: 1_700_000_000_000 });
    expect(await createLoginLink('user_1')).toEqual({ id: 'lnk', url: LINK_URL, createdAt: 1_700_000_000_000 });
    answer({ revoked: true });
    await removeLoginLink('user_1');
    expect(sent.map((one) => `${one.method} ${one.url}`)).toEqual([`POST ${API}/api/admin/users/user_1/login-link`, `DELETE ${API}/api/admin/users/user_1/login-link`]);
  });

  test('a refusal or an odd answer is an error', async () => {
    answer({ error: 'Login links work only with Metro accounts.' }, 409);
    let refused = '';
    await createLoginLink('user_1').catch((err: unknown) => { refused = err instanceof Error ? err.message : ''; });
    expect(refused).toBe('Login links work only with Metro accounts.');
    answer({ id: 'lnk' });
    await createLoginLink('user_1').catch((err: unknown) => { refused = err instanceof Error ? err.message : ''; });
    expect(refused).toBe('Metro returned an unexpected response.');
  });
});
