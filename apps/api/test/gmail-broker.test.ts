import { describe, expect, test } from 'bun:test';
import { pkcePair } from '@metro-labs/core/stations/oauth';
import { readGmailGrant } from '../src/gmail/grants.js';
import { AGENT, CONFIG, HOST, PKCE, READ_SCOPE, SEND_SCOPE, SERVER, SESSION, START, gmailFixture } from './gmail-fake.js';

describe('managed Gmail sign-in', () => {
  test('binds a saved box to a ten-minute PKCE flow, read-only unless sending is explicit', async () => {
    const f = gmailFixture();
    const start = await f.start();
    expect(start.expiresAt).toBe(f.state.now + 600_000);
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(start.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.clientId, redirect_uri: 'https://metro.box/', response_type: 'code', state: start.state,
      code_challenge: PKCE.challenge, code_challenge_method: 'S256', access_type: 'offline',
      prompt: 'select_account consent', scope: READ_SCOPE, login_hint: START.mailbox,
    });
    const send = new URL((await f.start({ sendEnabled: true })).authorizeUrl);
    expect(send.searchParams.get('scope')).toBe(`${READ_SCOPE} ${SEND_SCOPE}`);
    expect(send.searchParams.get('include_granted_scopes')).toBe('true');
    expect(f.state.requests).toHaveLength(0);
    expect(f.state.allowedChecks).toEqual([[SESSION.userId, SESSION.organization], [SESSION.userId, SESSION.organization]]);
  });

  test('exchanges once with the shared secret and exact redirect, then verifies the actual mailbox', async () => {
    const f = gmailFixture();
    const start = await f.start({ mailbox: ' Mailbox@EXAMPLE.test ' });
    const tokens = await f.exchange(start.state);
    expect(tokens).toMatchObject({
      accessToken: 'fake-access', refreshToken: 'fake-refresh', accountEmail: 'mailbox@example.test',
      expiresAt: f.state.now + 3_600_000, managed: true, managedHost: HOST, sendEnabled: false,
    });
    const grant = readGmailGrant(tokens.refreshGrant, tokens.refreshToken, HOST, CONFIG, f.state.now);
    expect(grant).toMatchObject({
      organization: SESSION.organization, userId: SESSION.userId, serverId: SERVER, host: HOST, agentId: AGENT,
      email: 'mailbox@example.test', sendEnabled: false, clientId: CONFIG.clientId, issuedAt: f.state.now,
      expiresAt: f.state.now + 90 * 86_400_000,
    });
    expect(grant).not.toHaveProperty('refreshToken');
    expect(grant).not.toHaveProperty('sessionId');
    expect(JSON.stringify(grant)).not.toContain('fake-access');
    expect(JSON.stringify(grant)).not.toContain('fake-refresh');
    const [tokenCall, profileCall] = f.state.requests;
    expect(Object.fromEntries(new URLSearchParams(String(tokenCall?.init?.body)))).toEqual({
      client_id: CONFIG.clientId, client_secret: CONFIG.clientSecret, redirect_uri: 'https://metro.box/',
      code_verifier: PKCE.verifier, grant_type: 'authorization_code', code: 'fake-code',
    });
    expect(profileCall?.init?.headers).toEqual({ authorization: 'Bearer fake-access', accept: 'application/json' });
    for (const call of f.state.requests) {
      expect(call.init?.redirect).toBe('manual');
      expect(call.init?.cache).toBe('no-store');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    await expect(f.exchange(start.state)).rejects.toThrow('stale');
    expect(f.state.requests).toHaveLength(2);
  });

  test('cancellation handles denied consent without any Google request and burns the ticket', async () => {
    const f = gmailFixture();
    const { state } = await f.start();
    expect(f.broker.cancel(SESSION, { state, host: HOST, agentId: AGENT })).toEqual({ cancelled: true });
    expect(() => f.broker.cancel(SESSION, { state, host: HOST, agentId: AGENT })).toThrow('stale');
    expect(() => f.broker.cancel(SESSION, { state: 'unknown', host: HOST, agentId: AGENT })).toThrow('stale');
    await expect(f.exchange(state)).rejects.toThrow('stale');
    expect(f.state.requests).toHaveLength(0);
  });

  test('only one concurrent exchange reaches Google, before the first request resolves', async () => {
    const f = gmailFixture();
    const { state } = await f.start();
    let release = (): void => {};
    f.state.hold = new Promise<void>((resolve) => { release = resolve; });
    const reachedGoogle = new Promise<void>((resolve) => { f.state.onRequest = resolve; });
    const first = f.exchange(state);
    await expect(f.exchange(state)).rejects.toThrow('stale');
    await reachedGoogle;
    expect(f.state.requests).toHaveLength(1);
    release();
    await expect(first).resolves.toMatchObject({ accountEmail: START.mailbox });
  });

  for (const [name, actor, body] of [
    ['user', { ...SESSION, userId: 'other-user' }, {}],
    ['organization', { ...SESSION, organization: 'org_01OTHERORG0000' }, {}],
    ['session', { ...SESSION, sessionId: 'other-session' }, {}],
    ['host', SESSION, { host: 'other.tail1234.ts.net' }],
    ['agent', SESSION, { agentId: 'other000001' }],
  ] as const) {
    test(`refuses the wrong ${name} without burning the owner's pending sign-in`, async () => {
      const f = gmailFixture();
      const { state } = await f.start();
      expect(() => f.broker.cancel(actor, { state, host: HOST, agentId: AGENT, ...body })).toThrow('stale');
      await expect(f.exchange(state, body, actor)).rejects.toThrow('stale');
      expect(f.state.requests).toHaveLength(0);
      expect(f.state.allowedChecks).toHaveLength(1);
      expect(f.states.size(f.state.now)).toBe(1);
      await expect(f.exchange(state)).resolves.toMatchObject({ accountEmail: START.mailbox });
      await expect(f.exchange(state)).rejects.toThrow('stale');
    });
  }

  test('a matching actor with wrong or invalid PKCE burns only its own ticket', async () => {
    for (const verifier of [pkcePair().verifier, 'short']) {
      const f = gmailFixture();
      const { state } = await f.start();
      await expect(f.exchange(state, { verifier })).rejects.toThrow();
      await expect(f.exchange(state)).rejects.toThrow('stale');
      expect(f.states.size(f.state.now)).toBe(0);
      expect(f.state.requests).toHaveLength(0);
    }
  });

  test('expiry, ownership changes and revoked user access are checked before Google', async () => {
    for (const change of ['expired', 'removed', 'moved', 'replaced', 'host', 'user']) {
      const f = gmailFixture();
      const { state } = await f.start();
      if (change === 'expired') f.state.now += 600_000;
      if (change === 'removed') f.state.rows = [];
      if (change === 'moved') f.state.rows[0]!.organization = 'org_01OTHERORG0000';
      if (change === 'replaced') f.state.rows[0]!.id = 'saved000002';
      if (change === 'host') f.state.rows[0]!.host = 'other.tail1234.ts.net';
      if (change === 'user') f.state.allowed = false;
      await expect(f.exchange(state)).rejects.toThrow();
      expect(f.state.requests).toHaveLength(0);
      expect(f.states.size(f.state.now)).toBe(0);
    }
  });

  test('membership and exact ownership are checked again after Google verifies the mailbox', async () => {
    for (const change of ['removed', 'moved', 'replaced', 'host', 'user']) {
      const f = gmailFixture();
      const { state } = await f.start();
      f.state.onRequest = () => {
        if (f.state.requests.length !== 2) return;
        if (change === 'removed') f.state.rows = [];
        if (change === 'moved') f.state.rows[0]!.organization = 'org_01OTHERORG0000';
        if (change === 'replaced') f.state.rows[0]!.id = 'saved000002';
        if (change === 'host') f.state.rows[0]!.host = 'other.tail1234.ts.net';
        if (change === 'user') f.state.allowed = false;
      };
      await expect(f.exchange(state)).rejects.toThrow();
      expect(f.state.requests).toHaveLength(2);
      expect(f.state.allowedChecks).toHaveLength(3);
      await expect(f.exchange(state)).rejects.toThrow('stale');
    }
  });

  test('an unsaved or foreign box cannot start, even if the address is syntactically valid', async () => {
    const f = gmailFixture();
    await expect(f.start({ host: '169.254.169.254' })).rejects.toThrow('server');
    await expect(f.start({}, { ...SESSION, organization: 'org_01OTHERORG0000' })).rejects.toThrow('server');
    f.state.allowed = false;
    await expect(f.start()).rejects.toThrow('account');
    expect(f.states.size()).toBe(0);
    expect(f.state.requests).toHaveLength(0);
  });

  test('no provider input, redirect override, noncanonical host or implicit sending is accepted', async () => {
    const f = gmailFixture();
    for (const body of [
      { host: `https://${HOST}` }, { host: HOST.toUpperCase() }, { host: ` ${HOST}` },
      { host: 'x@example.test' }, { agentId: '../other' }, { challenge: 'plain' }, { mailbox: 'not-email' },
      { sendEnabled: undefined }, { sendEnabled: 'true' }, { sendEnabled: 1 },
      { redirectUri: 'https://attacker.test' }, { tokenEndpoint: 'https://attacker.test' }, { clientSecret: 'injected' },
    ]) await expect(f.start(body)).rejects.toThrow();
    expect(f.state.requests).toHaveLength(0);
    expect(f.states.size()).toBe(0);
  });

  for (const scope of [undefined, '', SEND_SCOPE, `${READ_SCOPE} ${SEND_SCOPE}`, `${READ_SCOPE} https://www.googleapis.com/auth/gmail.modify`, [READ_SCOPE]]) {
    test(`read-only consent refuses missing or excess scopes ${JSON.stringify(scope)}`, async () => {
      const f = gmailFixture();
      const { state } = await f.start();
      f.state.token.scope = scope;
      await expect(f.exchange(state)).rejects.toThrow('permissions');
      expect(f.state.requests).toHaveLength(1);
    });
  }

  test('sending needs both approved scopes, never just one', async () => {
    const f = gmailFixture();
    const { state } = await f.start({ sendEnabled: true });
    await expect(f.exchange(state)).rejects.toThrow('permissions');
    await expect(f.connected(true)).resolves.toMatchObject({ sendEnabled: true });
  });

  test('refuses a different actual mailbox or a profile that Google could not verify', async () => {
    const f = gmailFixture();
    f.state.profile.emailAddress = 'different@example.test';
    await expect(f.exchange((await f.start()).state)).rejects.toThrow('different mailbox');
    f.state.profileStatus = 403;
    await expect(f.exchange((await f.start()).state)).rejects.toThrow('verify');
    f.state.profileStatus = 200;
    f.state.profile = {};
    await expect(f.exchange((await f.start()).state)).rejects.toThrow('identify');
  });

  test('a missing refresh token, provider refusal and network failure return only safe sentences', async () => {
    const f = gmailFixture();
    delete f.state.token.refresh_token;
    await expect(f.exchange((await f.start()).state)).rejects.toThrow('tokens needed');
    f.state.tokenStatus = 400;
    f.state.token = { error: 'access_denied', error_description: 'private fake-code fake-refresh' };
    await expect(f.exchange((await f.start()).state)).rejects.toThrow('Google refused this Gmail sign-in. Connect Gmail again.');
    const { state } = await f.start();
    f.state.failure = new Error('private fake-code fake-client-secret');
    await expect(f.exchange(state)).rejects.toThrow('Google could not be reached for Gmail sign-in. Try again.');
    await expect(f.exchange(state)).rejects.toThrow('stale');
  });
});
