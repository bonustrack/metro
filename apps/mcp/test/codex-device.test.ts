import { describe, expect, test } from 'bun:test';
import { beginDeviceLogin, pollDeviceLogin } from '../src/gateway/codex-device.ts';

const jwt = (claims: Record<string, unknown>): string => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
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

describe('the device-code sign-in the Codex CLI does, driven from the page', () => {
  test('a code is requested, polled no faster than the interval, exchanged with the verifier OpenAI returns, and forgotten', async () => {
    let polls = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith('/api/accounts/deviceauth/usercode')) return json({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH', interval: '2' });
      if (call.url.endsWith('/api/accounts/deviceauth/token')) {
        polls += 1;
        return polls < 3 ? json({ error: 'authorization_pending' }, 403) : json({ authorization_code: 'ac-1', code_challenge: 'ch', code_verifier: 'ver' });
      }
      return json({ id_token: idToken, access_token: 'at-1', refresh_token: 'rt-1' });
    });
    const login = await beginDeviceLogin('https://issuer.test', fetchImpl, 1_000);
    expect(login).toMatchObject({ userCode: 'ABCD-EFGH', verifyUrl: 'https://issuer.test/codex/device', interval: 2 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
    expect(await pollDeviceLogin(login.id, fetchImpl, 1_000)).toEqual({ status: 'pending' });
    expect(polls).toBe(1);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH' });
    expect(await pollDeviceLogin(login.id, fetchImpl, 1_500)).toEqual({ status: 'pending' });
    expect(polls).toBe(1);
    expect(await pollDeviceLogin(login.id, fetchImpl, 3_000)).toEqual({ status: 'pending' });
    expect(polls).toBe(2);
    const done = await pollDeviceLogin(login.id, fetchImpl, 5_000);
    expect(done.status).toBe('done');
    if (done.status === 'done') expect(done.tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acct_1', email: 'less@example.com', plan: 'pro' });
    const exchange = calls.at(-1);
    expect(exchange?.url).toBe('https://issuer.test/oauth/token');
    const form = new URLSearchParams(String(exchange?.init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('ac-1');
    expect(form.get('code_verifier')).toBe('ver');
    expect(form.get('redirect_uri')).toBe('https://issuer.test/deviceauth/callback');
    await expect(pollDeviceLogin(login.id, fetchImpl, 5_000)).rejects.toThrow('expired or already finished');
  });

  test('no device-code offer, a refusal mid-way, a stale id and a forgotten login each say so', async () => {
    const off = fakeFetch(() => new Response('nope', { status: 404 }));
    await expect(beginDeviceLogin('https://issuer.test', off.fetchImpl)).rejects.toThrow('browser sign-in');
    const refusing = fakeFetch((call) => (call.url.endsWith('/usercode') ? json({ device_auth_id: 'dev_2', user_code: 'X', interval: 1 }) : json({ error: 'denied' }, 400)));
    const login = await beginDeviceLogin('https://issuer.test', refusing.fetchImpl, 1_000);
    expect(await pollDeviceLogin(login.id, refusing.fetchImpl, 2_000)).toEqual({ status: 'failed', error: 'OpenAI ended the device-code sign-in (400)' });
    await expect(pollDeviceLogin('nope', refusing.fetchImpl)).rejects.toThrow('press Connect again');
    const forgotten = await beginDeviceLogin('https://issuer.test', refusing.fetchImpl, 1_000);
    await expect(pollDeviceLogin(forgotten.id, refusing.fetchImpl, 1_000 + 16 * 60_000)).rejects.toThrow('expired');
  });
});
