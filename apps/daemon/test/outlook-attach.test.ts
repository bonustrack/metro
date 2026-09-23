import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AttachSessions, type AttachOwner, type AttachView } from '../src/stations/attach-session.ts';
import { isInteractiveStation } from '../src/stations/attach-interactive.ts';

const LOGIN = 'https://login.test/common';
const GRAPH = 'https://graph.test/v1.0';
const ADA: AttachOwner = { agentId: 'agent000001' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let tokenAnswers: Response[] = [];
let exchanges: URLSearchParams[] = [];
let stored: { station: string; config: Record<string, unknown> }[] = [];
let me: Record<string, string> = {};
const realFetch = globalThis.fetch;

function fakeMicrosoft(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === `${LOGIN}/oauth2/v2.0/devicecode`)
    return Promise.resolve(json({ device_code: 'dc', user_code: 'XK7P9QRT', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 0 }));
  if (url === `${LOGIN}/oauth2/v2.0/token`) {
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (body.get('grant_type') === 'authorization_code') exchanges.push(body);
    return Promise.resolve(tokenAnswers.shift() ?? json({ error: 'authorization_pending' }, 400));
  }
  if (url.startsWith(`${GRAPH}/me?`)) return Promise.resolve(json(me));
  return Promise.resolve(json({}, 404));
}

const sessions = (): AttachSessions =>
  new AttachSessions({
    authorize: () => Promise.resolve(),
    complete: (_owner, station, config) => {
      stored.push({ station, config });
      return Promise.resolve({ accountId: 'acct-o1', activated: true });
    },
  });

async function settle(s: AttachSessions, attachId: string): Promise<AttachView> {
  for (let i = 0; i < 100; i += 1) {
    const view = s.view(ADA, attachId);
    if (view.status !== 'pending') return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  return s.view(ADA, attachId);
}

const query = (view: AttachView): URLSearchParams => new URL(view.authorizeUrl ?? 'https://x/').searchParams;

beforeEach(() => {
  process.env.METRO_OUTLOOK_LOGIN_URL = LOGIN;
  process.env.METRO_OUTLOOK_GRAPH_URL = GRAPH;
  process.env.METRO_OUTLOOK_CLIENT_ID = 'test-client';
  delete process.env.METRO_OUTLOOK_REDIRECT;
  tokenAnswers = [];
  exchanges = [];
  stored = [];
  me = { mail: 'Andy@Anderra.ch', displayName: 'Andy' };
  globalThis.fetch = fakeMicrosoft as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('connecting Outlook through the Microsoft sign-in page', () => {
  test('outlook is an interactive station', () => {
    expect(isInteractiveStation('outlook')).toBe(true);
  });

  test('start answers the browser step with a PKCE authorize link back to metro.box', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    expect(started).toMatchObject({ status: 'pending', step: 'browser', userCode: null });
    expect(started.authorizeUrl?.startsWith(`${LOGIN}/oauth2/v2.0/authorize?`)).toBe(true);
    const q = query(started);
    expect(q.get('client_id')).toBe('test-client');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('https://metro.box/');
    expect(q.get('response_mode')).toBe('query');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('scope')).toContain('offline_access');
    expect(q.get('state')?.length).toBeGreaterThan(20);
    expect(started.expiresAt).toBeGreaterThan(Date.now() + 14 * 60_000);
    await s.stop();
  });

  test('METRO_OUTLOOK_REDIRECT names another page', async () => {
    process.env.METRO_OUTLOOK_REDIRECT = 'http://localhost:5173/';
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    expect(query(started).get('redirect_uri')).toBe('http://localhost:5173/');
    await s.stop();
  });

  test('the code comes back with its state, is exchanged with the verifier, and the mailbox is stored', async () => {
    tokenAnswers = [json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    const q = query(started);
    await s.submit(ADA, started.attachId, { code: 'the-code', state: q.get('state') });
    const done = await settle(s, started.attachId);
    expect(done).toMatchObject({ status: 'done', accountId: 'acct-o1', identity: { email: 'andy@anderra.ch', name: 'Andy' }, authorizeUrl: null });
    const sent = exchanges[0];
    expect(sent?.get('code')).toBe('the-code');
    expect(sent?.get('redirect_uri')).toBe('https://metro.box/');
    expect(sent?.get('client_secret')).toBeNull();
    const verifier = sent?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(q.get('code_challenge') ?? '');
    expect(stored[0]?.config).toMatchObject({ accountEmail: 'andy@anderra.ch', refreshToken: 'rt' });
    await s.stop();
  });

  test('a code with another state is refused and the sign-in stays open', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    await expect(s.submit(ADA, started.attachId, { code: 'c', state: 'not-it' })).rejects.toThrow('another attempt');
    expect(s.view(ADA, started.attachId).status).toBe('pending');
    expect(exchanges).toEqual([]);
    await s.stop();
  });

  test('a refused exchange fails with a plain sentence and stores nothing', async () => {
    tokenAnswers = [json({ error: 'invalid_grant', error_description: 'AADSTS65001: consent required' }, 400)];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    await s.submit(ADA, started.attachId, { code: 'c', state: query(started).get('state') });
    const failed = await settle(s, started.attachId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('must approve Metro once');
    expect(failed.error).toContain('/organizations/adminconsent?client_id=test-client');
    expect(stored).toEqual([]);
    await s.stop();
  });

  test('an error Microsoft sent back to the page fails the sign-in in plain words', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    await s.submit(ADA, started.attachId, {
      state: query(started).get('state'),
      error: 'access_denied',
      errorDescription: 'AADSTS65004: User declined to consent',
    });
    const failed = await settle(s, started.attachId);
    expect(failed.error).toContain('declined');
    await s.stop();
  });
});

describe('naming the mailbox to connect', () => {
  const signIn = async (mailbox: string): Promise<AttachView> => {
    tokenAnswers = [json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', { mailbox });
    await s.submit(ADA, started.attachId, { code: 'the-code', state: query(started).get('state') });
    const done = await settle(s, started.attachId);
    await s.stop();
    return done;
  };

  test('the mailbox rides as the login hint, and account selection stays on', async () => {
    const s = sessions();
    const q = query(await s.start(ADA, 'outlook', { mailbox: ' Andy@Anderra.ch ' }));
    expect(q.get('login_hint')).toBe('andy@anderra.ch');
    expect(q.get('prompt')).toBe('select_account');
    await s.stop();
  });

  test('no mailbox, no hint', async () => {
    const s = sessions();
    expect(query(await s.start(ADA, 'outlook', {})).get('login_hint')).toBeNull();
    await s.stop();
  });

  test('something that is not an address is refused before any sign-in', async () => {
    const s = sessions();
    await expect(s.start(ADA, 'outlook', { mailbox: 'andy' })).rejects.toThrow('whole address');
    await s.stop();
  });

  test('the named mailbox connects', async () => {
    const done = await signIn('andy@anderra.ch');
    expect(done).toMatchObject({ status: 'done', identity: { email: 'andy@anderra.ch' } });
    expect(stored[0]?.config).toMatchObject({ accountEmail: 'andy@anderra.ch' });
  });

  test('the user principal name counts too', async () => {
    me = { mail: 'andy@anderra.ch', userPrincipalName: 'andy.m@anderra.onmicrosoft.com', displayName: 'Andy' };
    expect((await signIn('andy.m@anderra.onmicrosoft.com')).status).toBe('done');
  });

  test('another account is refused and nothing is stored', async () => {
    me = { mail: 'fabien@anderra.ch', displayName: 'Fabien' };
    const failed = await signIn('andy@anderra.ch');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(
      'You signed in as fabien@anderra.ch, not andy@anderra.ch. Nothing was connected. Start again and pick andy@anderra.ch on Microsoft\'s page, or use "Use another account".',
    );
    expect(stored).toEqual([]);
  });

  test('the sign-in code checks the mailbox the same way', async () => {
    me = { mail: 'fabien@anderra.ch', displayName: 'Fabien' };
    tokenAnswers = [json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', { mailbox: 'andy@anderra.ch' });
    await s.submit(ADA, started.attachId, { mode: 'device' });
    const failed = await settle(s, started.attachId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('You signed in as fabien@anderra.ch, not andy@anderra.ch.');
    expect(stored).toEqual([]);
    await s.stop();
  });
});

describe('the sign-in code, for tenants that allow it', () => {
  test('switching to a code shows it, and the account is stored once Microsoft says yes', async () => {
    tokenAnswers = [json({ error: 'authorization_pending' }, 400), json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    const switched = await s.submit(ADA, started.attachId, { mode: 'device' });
    expect(switched).toMatchObject({ status: 'pending', step: 'device', userCode: 'XK7P9QRT', authorizeUrl: null });
    const done = await settle(s, started.attachId);
    expect(done).toMatchObject({ status: 'done', identity: { email: 'andy@anderra.ch', name: 'Andy' }, userCode: null });
    expect(stored[0]?.config).toMatchObject({ accountEmail: 'andy@anderra.ch', refreshToken: 'rt', accessToken: 'at' });
    await s.stop();
  });

  test('a tenant that blocks the code flow says so', async () => {
    tokenAnswers = [json({ error: 'invalid_grant', error_description: 'AADSTS530035: Access has been blocked by security defaults' }, 400)];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    await s.submit(ADA, started.attachId, { mode: 'device' });
    const failed = await settle(s, started.attachId);
    expect(failed.error).toContain('Your company blocks this kind of sign-in');
    await s.stop();
  });
});
