import { describe, expect, test } from 'bun:test';
import {
  buildStartRedirect,
  completeCallback,
  validateReturnTo,
  type CallbackDeps,
  type OAuthConfig,
} from '../src/daemon/google-oauth.ts';
import { parseEmailAgentMap } from '../src/daemon/google-auth.ts';
import { signState, verifySession } from '../src/daemon/session.ts';

const cfg: OAuthConfig = {
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  redirectUri: 'https://mcp.metro.box/auth/google/callback',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  sessionSecret: 'sign-secret',
  emailAgents: parseEmailAgentMap('{"fabien@bonustrack.co":["tony"]}'),
  signinDomains: [],
  sessionTtlSec: 3600,
};

const restricted: OAuthConfig = { ...cfg, signinDomains: ['bonustrack.co'] };

const okDeps = (email: string): CallbackDeps => ({
  exchangeCode: () => Promise.resolve({ id_token: 'fake-id-token' }),
  verifyIdToken: () => Promise.resolve({ email }),
});

const stateFrom = (url: string): string =>
  new URL(url).searchParams.get('state') ?? '';
const fragment = (url: string): URLSearchParams =>
  new URLSearchParams(url.split('#')[1] ?? '');

describe('validateReturnTo', () => {
  test('allows metro.box, netlify previews, and localhost', () => {
    expect(validateReturnTo('https://metro.box/')).toBe(true);
    expect(validateReturnTo('https://deploy-preview-42--metro-ui.netlify.app/x')).toBe(true);
    expect(validateReturnTo('https://metro-ui.netlify.app/')).toBe(true);
    expect(validateReturnTo('http://localhost:5175/')).toBe(true);
    expect(validateReturnTo('http://127.0.0.1:5173/')).toBe(true);
  });

  test('rejects open-redirect and hostile origins', () => {
    expect(validateReturnTo('https://metro.box.evil.com/')).toBe(false);
    expect(validateReturnTo('https://evil.com/')).toBe(false);
    expect(validateReturnTo('https://evil--metro-ui.netlify.app.evil.com/')).toBe(false);
    expect(validateReturnTo('http://metro.box/')).toBe(false);
    expect(validateReturnTo('javascript:alert(1)')).toBe(false);
    expect(validateReturnTo('//evil.com')).toBe(false);
    expect(validateReturnTo('not a url')).toBe(false);
  });
});

describe('buildStartRedirect', () => {
  test('builds a Google auth URL with a verifiable signed state', () => {
    const url = buildStartRedirect(cfg, 'https://metro.box/');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('client-abc');
    expect(u.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(u.searchParams.get('state')).toBeTruthy();
  });

  test('rejects an invalid return_to', () => {
    expect(() => buildStartRedirect(cfg, 'https://evil.com/')).toThrow(/return_to/);
  });
});

describe('completeCallback', () => {
  test('mints a session for an authorized email and redirects to return_to', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/app'));
    const redirect = await completeCallback(
      cfg,
      { code: 'c', state },
      okDeps('fabien@bonustrack.co'),
    );
    expect(redirect.startsWith('https://metro.box/app#')).toBe(true);
    expect(fragment(redirect).get('session')).toBeTruthy();
  });

  test('passes the state nonce through to id-token verification', async () => {
    const url = buildStartRedirect(cfg, 'https://metro.box/');
    const nonce = new URL(url).searchParams.get('nonce');
    let seen: string | undefined;
    await completeCallback(
      cfg,
      { code: 'c', state: stateFrom(url) },
      {
        exchangeCode: () => Promise.resolve({ id_token: 't' }),
        verifyIdToken: (_t, n) => {
          seen = n;
          return Promise.resolve({ email: 'fabien@bonustrack.co' });
        },
      },
    );
    expect(seen).toBe(nonce ?? '');
  });

  test('self-serve: an unmapped email signs in with an empty agent grant', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, okDeps('nobody@x.co'));
    const token = fragment(redirect).get('session');
    expect(token).toBeTruthy();
    expect(verifySession(token ?? '', cfg.sessionSecret)).toEqual({
      email: 'nobody@x.co',
      agents: [],
    });
  });

  test('METRO_SIGNIN_DOMAINS refuses an email outside the allowed domains', async () => {
    const state = stateFrom(buildStartRedirect(restricted, 'https://metro.box/'));
    const redirect = await completeCallback(
      restricted,
      { code: 'c', state },
      okDeps('nobody@x.co'),
    );
    expect(fragment(redirect).get('error')).toBe('unauthorized');
    expect(fragment(redirect).get('session')).toBeNull();
  });

  test('METRO_SIGNIN_DOMAINS admits an in-domain email', async () => {
    const state = stateFrom(buildStartRedirect(restricted, 'https://metro.box/'));
    const redirect = await completeCallback(
      restricted,
      { code: 'c', state },
      okDeps('newbie@bonustrack.co'),
    );
    expect(fragment(redirect).get('session')).toBeTruthy();
  });

  test('an explicit GOOGLE_EMAIL_AGENTS grant outranks a domain restriction', async () => {
    const other: OAuthConfig = { ...cfg, signinDomains: ['example.com'] };
    const state = stateFrom(buildStartRedirect(other, 'https://metro.box/'));
    const redirect = await completeCallback(
      other,
      { code: 'c', state },
      okDeps('fabien@bonustrack.co'),
    );
    const token = fragment(redirect).get('session');
    expect(verifySession(token ?? '', cfg.sessionSecret).agents).toEqual(['tony']);
  });

  test('redirects with error=verify when id-token verification fails', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, {
      exchangeCode: () => Promise.resolve({ id_token: 't' }),
      verifyIdToken: () => Promise.reject(new Error('bad token')),
    });
    expect(fragment(redirect).get('error')).toBe('verify');
  });

  test('redirects with error=exchange when no id_token comes back', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, {
      exchangeCode: () => Promise.resolve({}),
      verifyIdToken: () => Promise.resolve({ email: 'fabien@bonustrack.co' }),
    });
    expect(fragment(redirect).get('error')).toBe('exchange');
  });

  test('throws on a tampered/foreign state (no open redirect)', async () => {
    const foreign = signState({ return_to: 'https://metro.box/', nonce: 'n' }, 'other-secret');
    await expect(
      completeCallback(cfg, { code: 'c', state: foreign }, okDeps('fabien@bonustrack.co')),
    ).rejects.toThrow();
  });

  test('throws when state is missing', async () => {
    await expect(
      completeCallback(cfg, { code: 'c' }, okDeps('fabien@bonustrack.co')),
    ).rejects.toThrow(/state/);
  });

  test('a signed state carrying a disallowed return_to is refused', async () => {
    const sneaky = signState({ return_to: 'https://evil.com/', nonce: 'n' }, cfg.sessionSecret);
    await expect(
      completeCallback(cfg, { code: 'c', state: sneaky }, okDeps('fabien@bonustrack.co')),
    ).rejects.toThrow(/return_to/);
  });
});
