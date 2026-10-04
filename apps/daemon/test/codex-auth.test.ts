import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_NAME,
  beginLogin,
  chatgptHostId,
  CODEX_REDIRECT,
  finishLogin,
  NEW_CLIENT,
  OPENAI_API,
  parseCallback,
  PLAN_SCOPE,
  refreshTokens,
  tokensStale,
  type CodexTokens,
} from '../src/gateway/codex-auth.ts';
import { jwt } from './model-fixture.ts';

const ISSUER = 'https://issuer.test';
const HOST = 'urn:uuid:7d0f8c55-1b8e-4a47-9a7e-2f1d3c4b5a69';
const SCOPES = `chatgpt.tokens.use.direct email offline_access openid profile resource.invoke`;

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-chatgpt-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

const idToken = (claims: Record<string, unknown>): string => jwt({ iss: ISSUER, aud: 'oaiapp_1', sub: 'user-1', email: 'less@example.com', ...claims });

const granted = (nonce: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'at-1',
  refresh_token: 'rt-1',
  id_token: idToken({ nonce }),
  token_type: 'Bearer',
  expires_in: 3600,
  scope: SCOPES,
  ...extra,
});

const started = (previous: CodexTokens | null = null): { url: URL; state: string; nonce: string } => {
  const url = new URL(beginLogin(previous, HOST, ISSUER));
  return { url, state: url.searchParams.get('state') ?? '', nonce: url.searchParams.get('nonce') ?? '' };
};

const saved = (): CodexTokens => ({ clientId: 'oaiapp_1', subject: 'user-1', email: 'less@example.com', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.parse('2026-10-04T13:00:00Z'), savedAt: '2026-10-04T12:00:00.000Z' });

describe('Sign in with ChatGPT, the way OpenAI documents it for open-source apps', () => {
  test('a first sign-in registers Metro on this host: dynamic client, app name, host id, plan scope, resource, PKCE and a nonce', () => {
    const { url, state, nonce } = started();
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    const query = Object.fromEntries(url.searchParams);
    expect(query).toMatchObject({
      client_id: NEW_CLIENT,
      agent_name_hint: APP_NAME,
      ext_agent_host_id: HOST,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
      resource: OPENAI_API,
      code_challenge_method: 'S256',
    });
    expect(OPENAI_API).toBe('https://api.openai.com/v1');
    expect(query.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.login_hint).toBeUndefined();
  });

  test('signing a connection in again reuses its issued client, without the app name, with its email as the hint', () => {
    const { url } = started(saved());
    expect(url.searchParams.get('client_id')).toBe('oaiapp_1');
    expect(url.searchParams.get('agent_name_hint')).toBeNull();
    expect(url.searchParams.get('login_hint')).toBe('less@example.com');
    expect(url.searchParams.get('ext_agent_host_id')).toBe(HOST);
  });

  test('the host id is made once per box, kept owner-only, and a bad file gets a new one', () => {
    const dir = scratch();
    const first = chatgptHostId(dir);
    expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(chatgptHostId(dir)).toBe(first);
    expect(statSync(join(dir, 'chatgpt-host.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'chatgpt-host.json'), 'utf8'))).toEqual({ hostId: first });
    writeFileSync(join(dir, 'chatgpt-host.json'), '{"hostId":"me@example.com"}');
    expect(chatgptHostId(dir)).not.toBe(first);
  });

  test('the pasted address is read leniently, and a refusal in it is said plainly', () => {
    expect(parseCallback(' http://127.0.0.1:1455/auth/callback?code=abc&state=xyz&client_id=oaiapp_1 ')).toEqual({ code: 'abc', state: 'xyz', clientId: 'oaiapp_1' });
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz', clientId: null });
    expect(() => parseCallback('http://127.0.0.1:1455/auth/callback')).toThrow(/code= and state=/);
    expect(() => parseCallback('http://127.0.0.1:1455/auth/callback?error=access_denied&state=xyz')).toThrow(/did not allow Metro/);
    expect(() => parseCallback('?error=server_error&error_description=down&state=xyz')).toThrow(/stopped the sign-in \(down\)/);
  });

  test('finishing exchanges the code as a form with the issued client, the verifier, the redirect and the resource, once', async () => {
    const { state, nonce, url } = started();
    const { calls, fetchImpl } = fakeFetch(() => json(granted(nonce)));
    const now = Date.parse('2026-10-04T12:00:00Z');
    const tokens = await finishLogin(`${CODEX_REDIRECT}?code=the-code&scope=x&state=${state}&client_id=oaiapp_1`, ISSUER, fetchImpl, now);
    expect(tokens).toEqual({ clientId: 'oaiapp_1', subject: 'user-1', email: 'less@example.com', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: now + 3_600_000, savedAt: '2026-10-04T12:00:00.000Z' });
    expect(calls[0]?.url).toBe(`${ISSUER}/api/accounts/oauth/token`);
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    const form = Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)));
    expect(form).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_1', code: 'the-code', redirect_uri: CODEX_REDIRECT, resource: OPENAI_API });
    expect(createHash('sha256').update(form.code_verifier ?? '').digest('base64url')).toBe(url.searchParams.get('code_challenge') ?? 'none');
    await expect(finishLogin(`?code=again&state=${state}&client_id=oaiapp_1`, ISSUER, fetchImpl, now)).rejects.toThrow(/expired or was started elsewhere/);
  });

  test('a sign-in that is not complete, not the same account, not for this nonce or without the plan is refused', async () => {
    const ok = (nonce: string): ReturnType<typeof fakeFetch> => fakeFetch(() => json(granted(nonce)));
    const plain = started();
    await expect(finishLogin(`?code=c&state=${plain.state}`, ISSUER, ok(plain.nonce).fetchImpl)).rejects.toThrow(/did not finish registering/);
    const again = started(saved());
    await expect(finishLogin(`?code=c&state=${again.state}&client_id=oaiapp_2`, ISSUER, ok(again.nonce).fetchImpl)).rejects.toThrow(/another Metro registration/);
    const other = started(saved());
    const otherAccount = fakeFetch(() => json(granted(other.nonce, { id_token: idToken({ nonce: other.nonce, sub: 'user-2' }) })));
    await expect(finishLogin(`?code=c&state=${other.state}`, ISSUER, otherAccount.fetchImpl)).rejects.toThrow(/another ChatGPT account/);
    const replay = started();
    await expect(finishLogin(`?code=c&state=${replay.state}&client_id=oaiapp_1`, ISSUER, ok('another-nonce').fetchImpl)).rejects.toThrow(/does not match this sign-in/);
    const planless = started();
    const noPlan = fakeFetch(() => json(granted(planless.nonce, { scope: 'openid profile email offline_access' })));
    await expect(finishLogin(`?code=c&state=${planless.state}&client_id=oaiapp_1`, ISSUER, noPlan.fetchImpl)).rejects.toThrow(/Plus or Pro/);
    const refused = started();
    const bad = fakeFetch(() => json({ error: 'invalid_grant', error_description: 'code expired' }, 400));
    await expect(finishLogin(`?code=c&state=${refused.state}&client_id=oaiapp_1`, ISSUER, bad.fetchImpl)).rejects.toThrow(/\(400\): code expired/);
  });

  test('signing an existing connection in again keeps its client and account', async () => {
    const { state, nonce } = started(saved());
    const { fetchImpl } = fakeFetch(() => json(granted(nonce, { access_token: 'at-9', refresh_token: 'rt-9' })));
    expect(await finishLogin(`?code=c&state=${state}`, ISSUER, fetchImpl)).toMatchObject({ clientId: 'oaiapp_1', subject: 'user-1', accessToken: 'at-9', refreshToken: 'rt-9' });
  });

  test('a refresh is the form grant with the issued client and the resource, the rotated token replaces the old one, and stale means two minutes left', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer' }));
    const now = Date.parse('2026-10-04T12:58:30Z');
    const fresh = await refreshTokens(saved(), ISSUER, fetchImpl, now);
    expect(fresh).toMatchObject({ clientId: 'oaiapp_1', subject: 'user-1', email: 'less@example.com', accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: now + 3_600_000 });
    expect(calls[0]?.url).toBe(`${ISSUER}/api/accounts/oauth/token`);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)))).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_1', refresh_token: 'rt-1', resource: OPENAI_API });
    const kept = await refreshTokens(saved(), ISSUER, fakeFetch(() => json({ access_token: 'at-3' })).fetchImpl, now);
    expect(kept.refreshToken).toBe('rt-1');
    expect(tokensStale(saved(), Date.parse('2026-10-04T12:57:00Z'))).toBe(false);
    expect(tokensStale(saved(), now)).toBe(true);
    await expect(refreshTokens(saved(), ISSUER, fakeFetch(() => json({ error: 'invalid_grant' }, 400)).fetchImpl)).rejects.toThrow(/invalid_grant/);
  });
});
