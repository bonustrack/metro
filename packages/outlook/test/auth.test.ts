import { beforeEach, describe, expect, test } from 'bun:test';
import { failureOf, pollDeviceCode, requestDeviceCode, requireClientId, tenantOf, type DeviceCode } from '../src/auth.ts';
import { OUTLOOK_CLIENT_ID } from '../src/config.ts';
import { Account } from '../src/accounts.ts';
import { OutlookLogin, type OutlookLoginResult } from '../src/login.ts';
import { fakeFetch, GRAPH, json, LOGIN, useFakeMicrosoft, type Route } from './fake.ts';

const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

const CODE: DeviceCode = {
  deviceCode: 'dc-1',
  userCode: 'ABCD1234',
  verificationUri: 'https://microsoft.com/devicelogin',
  message: 'go',
  expiresAt: Date.now() + 60_000,
  intervalMs: 0,
};

const deviceRoute: Route = (req) =>
  req.url === `${LOGIN}/oauth2/v2.0/devicecode`
    ? json({ device_code: 'dc-1', user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 0, message: 'go' })
    : undefined;

function tokenAnswers(answers: Response[]): Route {
  return (req) => (req.url === `${LOGIN}/oauth2/v2.0/token` && req.body.includes('device_code') ? answers.shift() : undefined);
}

beforeEach(() => {
  useFakeMicrosoft();
});

describe('the device code', () => {
  test('asks for the mail scopes with the configured client id', async () => {
    const fake = fakeFetch([deviceRoute]);
    const code = await requestDeviceCode(fake.fetch, 0);
    expect(code.userCode).toBe('ABCD1234');
    expect(code.expiresAt).toBe(900_000);
    const body = new URLSearchParams(fake.seen[0]?.body);
    expect(body.get('client_id')).toBe('test-client');
    expect(body.get('scope')).toContain('https://graph.microsoft.com/Mail.Send');
    expect(body.get('scope')).toContain('offline_access');
  });

  test('refuses when Metro has no client id, and uses the built-in one unless the env names another', () => {
    expect(() => requireClientId('')).toThrow('Outlook is not set up on this Metro yet.');
    process.env.METRO_OUTLOOK_CLIENT_ID = '';
    expect(requireClientId()).toBe(OUTLOOK_CLIENT_ID);
    expect(OUTLOOK_CLIENT_ID).not.toBe('');
  });

  test('reads each poll answer', async () => {
    const fake = fakeFetch([
      tokenAnswers([
        json({ error: 'authorization_pending' }, 400),
        json({ error: 'slow_down' }, 400),
        json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: jwt({ tid: 'tenant-1' }) }),
      ]),
    ]);
    expect(await pollDeviceCode(CODE, fake.fetch, 0)).toEqual({ kind: 'pending' });
    expect(await pollDeviceCode(CODE, fake.fetch, 0)).toEqual({ kind: 'slow_down' });
    expect(await pollDeviceCode(CODE, fake.fetch, 0)).toEqual({
      kind: 'done',
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 3_600_000 },
      tenantId: 'tenant-1',
    });
  });

  test('turns refusals into plain sentences', () => {
    expect(failureOf({ error: 'expired_token' })).toBe('The sign-in code expired before it was used. Start again.');
    expect(failureOf({ error: 'access_denied' })).toContain('declined');
    const consent = failureOf({ error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented' }, 'cid');
    expect(consent).toContain('administrator of this Microsoft 365 organization must approve Metro once');
    expect(consent).toContain('client_id=cid');
    expect(failureOf({ error: 'invalid_grant', error_codes: [90094] })).toContain('must approve Metro once');
    expect(failureOf({ error: 'invalid_client', error_description: 'AADSTS700016: app not found\r\nTrace' })).toBe(
      'Microsoft refused the sign-in: AADSTS700016: app not found',
    );
  });

  test('takes the tenant from the first token that names one', () => {
    expect(tenantOf('opaque', jwt({ tid: 't2' }))).toBe('t2');
    expect(tenantOf('', 'opaque')).toBeNull();
  });
});

describe('the sign-in driver', () => {
  const me: Route = (req) =>
    req.url.startsWith(`${GRAPH}/me?`) && req.auth === 'Bearer at'
      ? json({ mail: null, userPrincipalName: 'Andy@Anderra.ch', displayName: 'Andy' })
      : undefined;

  function run(routes: Route[]): Promise<{ done?: OutlookLoginResult; failed?: string }> {
    const fake = fakeFetch(routes);
    return new Promise((resolve, reject) => {
      const login = new OutlookLogin(
        { onDone: (done) => { resolve({ done }); }, onFailed: (failed) => { resolve({ failed }); } },
        { fetch: fake.fetch },
      );
      login.start().catch(reject);
    });
  }

  test('polls until Microsoft hands over tokens, then checks the mailbox', async () => {
    const { done } = await run([
      deviceRoute,
      tokenAnswers([json({ error: 'authorization_pending' }, 400), json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: jwt({ tid: 'tn' }) })]),
      me,
    ]);
    expect(done?.identity).toEqual({ email: 'andy@anderra.ch', name: 'Andy' });
    expect(done?.config).toMatchObject({ accountEmail: 'andy@anderra.ch', refreshToken: 'rt', accessToken: 'at', tenantId: 'tn' });
  });

  test('a consent refusal ends the sign-in with the admin sentence', async () => {
    const { failed } = await run([deviceRoute, tokenAnswers([json({ error: 'invalid_grant', error_codes: [65001] }, 400)])]);
    expect(failed).toContain('must approve Metro once');
  });

  test('a token Graph refuses connects nothing', async () => {
    const { failed } = await run([deviceRoute, tokenAnswers([json({ access_token: 'bad', refresh_token: 'rt' })])]);
    expect(failed).toContain('Microsoft Graph refused the new sign-in');
  });
});

describe('the train token', () => {
  test('two callers at expiry share one refresh, and the new refresh token is kept on disk', async () => {
    let refreshes = 0;
    const fake = fakeFetch([
      (req) => {
        if (!req.url.startsWith(`${LOGIN}/oauth2/v2.0/token`)) return undefined;
        refreshes += 1;
        return json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
      },
    ]);
    const acct = new Account({ id: 'o1', accountEmail: 'a@b.ch', refreshToken: 'rt-old', accessToken: 'at-old', expiresAt: 0 }, fake.fetch);
    const [a, b] = await Promise.all([acct.token(), acct.token()]);
    expect([a, b]).toEqual(['at-new', 'at-new']);
    expect(refreshes).toBe(1);
    expect(new URLSearchParams(fake.seen[0]?.body).get('refresh_token')).toBe('rt-old');
    const again = new Account({ id: 'o1', accountEmail: 'a@b.ch', refreshToken: 'rt-old' }, fake.fetch);
    expect(again.state.refreshToken).toBe('rt-new');
    expect(await again.token()).toBe('at-new');
    expect(refreshes).toBe(1);
  });

  test('a refused refresh says to connect again', async () => {
    const fake = fakeFetch([(req) => (req.url.includes('/token') ? json({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }, 400) : undefined)]);
    const acct = new Account({ id: 'o2', accountEmail: 'a@b.ch', refreshToken: 'rt' }, fake.fetch);
    await expect(acct.token()).rejects.toThrow('connect Outlook again');
  });
});
