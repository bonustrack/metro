import { beforeEach, describe, expect, test } from 'bun:test';
import { failureOf } from '../src/auth.ts';
import { authorizeUrl, pkcePair } from '../src/browser.ts';
import { OutlookBrowserLogin } from '../src/login.ts';
import { fakeFetch, GRAPH, json, LOGIN, useFakeMicrosoft } from './fake.ts';

const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

beforeEach(() => {
  useFakeMicrosoft();
  delete process.env.METRO_OUTLOOK_REDIRECT;
});

describe('the browser sign-in', () => {
  test('derives the S256 challenge from the verifier (RFC 7636 appendix B)', () => {
    expect(pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });

  test('the authorize link carries the challenge, the state and the metro.box redirect', () => {
    const url = new URL(authorizeUrl('chal', 'st'));
    expect(`${url.origin}${url.pathname}`).toBe(`${LOGIN}/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'test-client',
      response_type: 'code',
      redirect_uri: 'https://metro.box/',
      response_mode: 'query',
      state: 'st',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  });

  test('a company that blocks the code flow gets a plain sentence', () => {
    expect(failureOf({ error: 'invalid_grant', error_description: 'AADSTS530035: blocked by security defaults' })).toContain(
      'Your company blocks this kind of sign-in',
    );
    expect(failureOf({ error: 'invalid_grant', error_codes: [53003] })).toContain('Your company blocks');
  });

  test('the driver checks the state, redeems the code once, and checks the mailbox', async () => {
    const fake = fakeFetch([
      (req) =>
        req.url === `${LOGIN}/oauth2/v2.0/token` && req.body.includes('grant_type=authorization_code')
          ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: jwt({ tid: 'tb' }) })
          : undefined,
      (req) => (req.url.startsWith(`${GRAPH}/me?`) ? json({ mail: 'Andy@Anderra.ch', displayName: 'Andy' }) : undefined),
    ]);
    const login = new OutlookBrowserLogin({ fetch: fake.fetch });
    await expect(login.finish('c', 'other')).rejects.toThrow('another attempt');
    const done = await login.finish('c', login.state);
    expect(done.config).toMatchObject({ accountEmail: 'andy@anderra.ch', refreshToken: 'rt', tenantId: 'tb' });
    expect(new URLSearchParams(fake.seen[0]?.body).get('code_verifier')?.length).toBeGreaterThan(40);
    await expect(login.finish('c', login.state)).rejects.toThrow('already used');
  });

  test('a refused exchange carries Microsoft reason in plain words', async () => {
    const fake = fakeFetch([
      (req) => (req.url.endsWith('/token') ? json({ error: 'invalid_grant', error_codes: [65001] }, 400) : undefined),
    ]);
    const login = new OutlookBrowserLogin({ fetch: fake.fetch });
    await expect(login.finish('c', login.state)).rejects.toThrow('must approve Metro once');
  });
});
