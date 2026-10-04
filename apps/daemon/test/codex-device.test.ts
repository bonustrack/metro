import { describe, expect, test } from 'bun:test';
import { beginDeviceLogin, pollDeviceLogin, refreshCodeTokens } from '../src/gateway/codex-device.ts';
import type { CodeTokens } from '../src/gateway/codex-auth.ts';
import { jwt } from './model-fixture.ts';

const CLI_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const idToken = jwt({ email: 'less@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'pro' } });

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signedIn = (): CodeTokens => ({ method: 'code', accountId: 'acct_1', email: 'less@example.com', plan: 'pro', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 0, savedAt: '2026-10-04T12:00:00.000Z' });

describe('the code sign-in the Codex app does, driven from the page', () => {
  test('a code is requested, polled no faster than the interval, exchanged with the verifier OpenAI returns, and forgotten', async () => {
    let polls = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith('/api/accounts/deviceauth/usercode')) return json({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH', interval: '2' });
      if (call.url.endsWith('/api/accounts/deviceauth/token')) {
        polls += 1;
        return polls < 3 ? json({ error: 'authorization_pending' }, 403) : json({ authorization_code: 'ac-1', code_challenge: 'ch', code_verifier: 'ver' });
      }
      return json({ id_token: idToken, access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    });
    const login = await beginDeviceLogin('https://issuer.test', fetchImpl, 1_000);
    expect(login).toMatchObject({ userCode: 'ABCD-EFGH', verifyUrl: 'https://issuer.test/codex/device', interval: 2 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client_id: CLI_CLIENT });
    expect(await pollDeviceLogin(login.id, fetchImpl, 1_000)).toEqual({ status: 'pending' });
    expect(polls).toBe(1);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH' });
    expect(await pollDeviceLogin(login.id, fetchImpl, 1_500)).toEqual({ status: 'pending' });
    expect(polls).toBe(1);
    expect(await pollDeviceLogin(login.id, fetchImpl, 3_000)).toEqual({ status: 'pending' });
    expect(polls).toBe(2);
    const done = await pollDeviceLogin(login.id, fetchImpl, 5_000);
    expect(done).toEqual({
      status: 'done',
      tokens: { method: 'code', accountId: 'acct_1', email: 'less@example.com', plan: 'pro', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 5_000 + 3_600_000, savedAt: new Date(5_000).toISOString() },
    });
    const exchange = calls.at(-1);
    expect(exchange?.url).toBe('https://issuer.test/oauth/token');
    const form = new URLSearchParams(String(exchange?.init.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'authorization_code', code: 'ac-1', redirect_uri: 'https://issuer.test/deviceauth/callback', client_id: CLI_CLIENT, code_verifier: 'ver' });
    await expect(pollDeviceLogin(login.id, fetchImpl, 5_000)).rejects.toThrow('expired or already finished');
  });

  test('no code offer, a refusal mid-way, a stale id, a forgotten login and an id token without an account each say so', async () => {
    const off = fakeFetch(() => new Response('nope', { status: 404 }));
    await expect(beginDeviceLogin('https://issuer.test', off.fetchImpl)).rejects.toThrow('Continue with ChatGPT');
    const refusing = fakeFetch((call) => (call.url.endsWith('/usercode') ? json({ device_auth_id: 'dev_2', user_code: 'X', interval: 1 }) : json({ error: 'denied' }, 400)));
    const login = await beginDeviceLogin('https://issuer.test', refusing.fetchImpl, 1_000);
    expect(await pollDeviceLogin(login.id, refusing.fetchImpl, 2_000)).toEqual({ status: 'failed', error: 'OpenAI ended the code sign-in (400)' });
    await expect(pollDeviceLogin('nope', refusing.fetchImpl)).rejects.toThrow('press Sign in with a code again');
    const forgotten = await beginDeviceLogin('https://issuer.test', refusing.fetchImpl, 1_000);
    await expect(pollDeviceLogin(forgotten.id, refusing.fetchImpl, 1_000 + 16 * 60_000)).rejects.toThrow('expired');
    const noAccount = fakeFetch((call) => {
      if (call.url.endsWith('/usercode')) return json({ device_auth_id: 'dev_3', user_code: 'Y', interval: 1 });
      if (call.url.endsWith('/deviceauth/token')) return json({ authorization_code: 'ac-3', code_verifier: 'ver' });
      return json({ id_token: jwt({ email: 'less@example.com' }), access_token: 'at', refresh_token: 'rt' });
    });
    const third = await beginDeviceLogin('https://issuer.test', noAccount.fetchImpl, 1_000);
    const failed = await pollDeviceLogin(third.id, noAccount.fetchImpl, 1_000);
    expect(failed.status === 'failed' ? failed.error : '').toContain('no ChatGPT account id');
  });

  test('a refresh is the JSON grant of the Codex app client, and what the answer leaves out is kept', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ access_token: 'at-2', refresh_token: 'rt-2' }));
    const now = Date.parse('2026-10-04T13:00:00Z');
    const fresh = await refreshCodeTokens(signedIn(), 'https://issuer.test', fetchImpl, now);
    expect(calls[0]?.url).toBe('https://issuer.test/oauth/token');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client_id: CLI_CLIENT, grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(fresh).toEqual({ method: 'code', accountId: 'acct_1', email: 'less@example.com', plan: 'pro', accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: now + 3_600_000, savedAt: '2026-10-04T13:00:00.000Z' });
    const kept = await refreshCodeTokens(signedIn(), 'https://issuer.test', fakeFetch(() => json({ access_token: 'at-3', id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) })).fetchImpl, now);
    expect(kept).toMatchObject({ accountId: 'acct_1', plan: 'plus', refreshToken: 'rt-1', accessToken: 'at-3' });
    await expect(refreshCodeTokens(signedIn(), 'https://issuer.test', fakeFetch(() => json({ error: 'invalid_grant' }, 400)).fetchImpl)).rejects.toThrow(/invalid_grant/);
  });
});
