import { beforeEach, describe, expect, test } from 'bun:test';
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
  sessionTtlSec: 3600,
};

const GRANTED_IDS: Record<string, number> = { tony: 3, wan: 4 };
let grantLookups: string[][] = [];
let userTable = new Map<string, number>();
let ensured: string[] = [];

const grantedAgentIds = (names: string[]): Promise<number[]> => {
  grantLookups.push(names);
  const ids = names.map((n) => GRANTED_IDS[n]);
  return Promise.resolve(ids.filter((id): id is number => id !== undefined));
};

const ensureUser = (email: string): Promise<number> => {
  ensured.push(email);
  const known = userTable.get(email);
  if (known !== undefined) return Promise.resolve(known);
  const id = userTable.size + 1;
  userTable.set(email, id);
  return Promise.resolve(id);
};

beforeEach(() => {
  grantLookups = [];
  userTable = new Map();
  ensured = [];
});

const okDeps = (email: string): CallbackDeps => ({
  exchangeCode: () => Promise.resolve({ id_token: 'fake-id-token' }),
  verifyIdToken: () => Promise.resolve({ email }),
  ensureUser,
  grantedAgentIds,
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
        ensureUser,
        grantedAgentIds,
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
      agentIds: [],
    });
    expect(grantLookups).toEqual([]);
  });

  test('sign-in is open: any verified Google account gets a session, whatever the domain', async () => {
    for (const email of [
      'newbie@gmail.com',
      'someone@bonustrack.co',
      'user@sub.example.co.uk',
      'x@protonmail.com',
    ]) {
      const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
      const redirect = await completeCallback(cfg, { code: 'c', state }, okDeps(email));
      const token = fragment(redirect).get('session');
      expect(fragment(redirect).get('error')).toBeNull();
      expect(verifySession(token ?? '', cfg.sessionSecret).email).toBe(email);
    }
  });

  test('a first sign-in creates the user row for the verified email', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    await completeCallback(cfg, { code: 'c', state }, okDeps('newbie@gmail.com'));
    expect(ensured).toEqual(['newbie@gmail.com']);
    expect([...userTable.entries()]).toEqual([['newbie@gmail.com', 1]]);
  });

  test('signing in again reuses the same user id and adds no second row', async () => {
    for (let i = 0; i < 3; i += 1) {
      const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
      await completeCallback(cfg, { code: 'c', state }, okDeps('ada@lovelace.dev'));
    }
    expect(userTable.size).toBe(1);
    expect(userTable.get('ada@lovelace.dev')).toBe(1);
    expect(ensured.length).toBe(3);
  });

  test('the user row is created from the verified id-token email, never from state', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    await completeCallback(cfg, { code: 'c', state }, {
      ensureUser,
      grantedAgentIds,
      exchangeCode: () => Promise.resolve({ id_token: 't' }),
      verifyIdToken: () => Promise.resolve({ email: 'verified@example.com' }),
    });
    expect(ensured).toEqual(['verified@example.com']);
  });

  test('a failed id-token verification creates no user row', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, {
      ensureUser,
      grantedAgentIds,
      exchangeCode: () => Promise.resolve({ id_token: 't' }),
      verifyIdToken: () => Promise.reject(new Error('bad token')),
    });
    expect(fragment(redirect).get('error')).toBe('verify');
    expect(ensured).toEqual([]);
    expect(userTable.size).toBe(0);
  });

  test('a failed code exchange creates no user row', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    await completeCallback(cfg, { code: 'c', state }, {
      ensureUser,
      grantedAgentIds,
      exchangeCode: () => Promise.resolve({}),
      verifyIdToken: () => Promise.resolve({ email: 'never@x.co' }),
    });
    expect(userTable.size).toBe(0);
  });

  test('a GOOGLE_EMAIL_AGENTS grant still resolves to operator agent ids', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(
      cfg,
      { code: 'c', state },
      okDeps('fabien@bonustrack.co'),
    );
    const token = fragment(redirect).get('session');
    expect(verifySession(token ?? '', cfg.sessionSecret).agentIds).toEqual([3]);
    expect(grantLookups.at(-1)).toEqual(['tony']);
  });

  test('a grant name shared by several operator rows scopes the session to every one of them', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, {
      exchangeCode: () => Promise.resolve({ id_token: 'fake-id-token' }),
      verifyIdToken: () => Promise.resolve({ email: 'fabien@bonustrack.co' }),
      ensureUser,
      grantedAgentIds: () => Promise.resolve([3, 11]),
    });
    const token = fragment(redirect).get('session');
    expect(verifySession(token ?? '', cfg.sessionSecret).agentIds).toEqual([3, 11]);
  });

  test('redirects with error=verify when id-token verification fails', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, {
      ensureUser,
      grantedAgentIds,
      exchangeCode: () => Promise.resolve({ id_token: 't' }),
      verifyIdToken: () => Promise.reject(new Error('bad token')),
    });
    expect(fragment(redirect).get('error')).toBe('verify');
  });

  test('redirects with error=exchange when no id_token comes back', async () => {
    const state = stateFrom(buildStartRedirect(cfg, 'https://metro.box/'));
    const redirect = await completeCallback(cfg, { code: 'c', state }, {
      ensureUser,
      grantedAgentIds,
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
