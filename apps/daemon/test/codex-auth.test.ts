import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeUrl,
  beginLogin,
  claimsOf,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT,
  finishLogin,
  newPkce,
  parseCallback,
  readCodexCliAuth,
  refreshTokens,
  tokensFrom,
  tokensStale,
} from '../src/gateway/codex-auth.ts';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-codex-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

describe('the ChatGPT sign-in the Codex CLI does, done from the page', () => {
  test('PKCE and the authorize link match the Codex CLI byte for byte where it matters', () => {
    const { verifier, challenge } = newPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(authorizeUrl('st', challenge));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_REDIRECT,
      scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: 'st',
      originator: 'codex_cli_rs',
    });
  });

  test('the pasted address is read leniently, and the account comes from the id token', () => {
    expect(parseCallback('  http://localhost:1455/auth/callback?code=abc&state=xyz ')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(() => parseCallback('http://localhost:1455/auth/callback')).toThrow(/code= and state=/);
    expect(claimsOf(idToken)).toEqual({ accountId: 'acct_1', email: 'less@example.com', plan: 'pro' });
    expect(claimsOf('garbage')).toEqual({ accountId: null, email: null, plan: null });
    const tokens = tokensFrom({ id_token: idToken, access_token: 'at', refresh_token: 'rt' }, null, new Date('2026-09-07T00:00:00Z'));
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', accountId: 'acct_1', email: 'less@example.com', plan: 'pro', savedAt: '2026-09-07T00:00:00.000Z' });
    expect(tokensFrom({ access_token: 'at2' }, tokens).refreshToken).toBe('rt');
    expect(() => tokensFrom({ access_token: 'at', refresh_token: 'rt', id_token: jwt({}) }, null)).toThrow(/account id/);
    expect(tokensStale(tokens, Date.parse('2026-09-07T00:10:00Z'))).toBe(false);
    expect(tokensStale(tokens, Date.parse('2026-09-07T01:00:00Z'))).toBe(true);
  });

  test('finishing a login exchanges the code with the verifier it started with, once', async () => {
    const issuer = 'https://issuer.test';
    const { url, state } = beginLogin(issuer);
    expect(url.startsWith(`${issuer}/oauth/authorize?`)).toBe(true);
    const { calls, fetchImpl } = fakeFetch(() => json({ id_token: idToken, access_token: 'at', refresh_token: 'rt' }));
    const tokens = await finishLogin(`http://localhost:1455/auth/callback?code=the-code&state=${state}`, issuer, fetchImpl);
    expect(tokens.accountId).toBe('acct_1');
    expect(calls[0]?.url).toBe(`${issuer}/oauth/token`);
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: CODEX_REDIRECT, client_id: CODEX_CLIENT_ID });
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(finishLogin(`?code=again&state=${state}`, issuer, fetchImpl)).rejects.toThrow(/expired|elsewhere/);
    const refused = fakeFetch(() => json({ error: 'invalid_grant', error_description: 'bad code' }, 400));
    const { state: other } = beginLogin(issuer);
    await expect(finishLogin(`?code=x&state=${other}`, issuer, refused.fetchImpl)).rejects.toThrow(/bad code/);
  });

  test('a refresh is the JSON grant the Codex CLI sends, keeping what the answer omits', async () => {
    const previous = tokensFrom({ id_token: idToken, access_token: 'at', refresh_token: 'rt' }, null);
    const { calls, fetchImpl } = fakeFetch(() => json({ access_token: 'at2' }));
    const fresh = await refreshTokens(previous, 'https://issuer.test', fetchImpl);
    expect(fresh).toMatchObject({ accessToken: 'at2', refreshToken: 'rt', accountId: 'acct_1', email: 'less@example.com' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt' });
  });

  test('the Codex CLI login on the box can be reused, and an API-key login cannot', () => {
    const home = scratch();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'cli-at', refresh_token: 'cli-rt', account_id: 'acct_1' }, last_refresh: '2026-09-06T00:00:00Z' }));
    expect(readCodexCliAuth(home)).toMatchObject({ accessToken: 'cli-at', refreshToken: 'cli-rt', accountId: 'acct_1', email: 'less@example.com', savedAt: '2026-09-06T00:00:00Z' });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' }));
    expect(() => readCodexCliAuth(home)).toThrow(/API-key/);
    expect(() => readCodexCliAuth(scratch())).toThrow(/codex login/);
  });
});
