import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AttachSessions, type AttachOwner, type AttachView } from '../src/stations/attach-session.ts';
import { isInteractiveStation } from '../src/stations/attach-interactive.ts';

const AUTH = 'https://accounts.test/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.test/token';
const API = 'https://gmail.test';
const ADA: AttachOwner = { agentId: 'agent000001' };
const CLIENT = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let tokenAnswer: Response = json({});
let exchanges: URLSearchParams[] = [];
let stored: { station: string; config: Record<string, unknown> }[] = [];
let profile: Response = json({});
const realFetch = globalThis.fetch;

function fakeGoogle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === TOKEN) {
    exchanges.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    return Promise.resolve(tokenAnswer);
  }
  if (url === `${API}/gmail/v1/users/me/profile`) return Promise.resolve(profile);
  return Promise.resolve(json({}, 404));
}

const sessions = (): AttachSessions =>
  new AttachSessions({
    authorize: () => Promise.resolve(),
    complete: (_owner, station, config) => {
      stored.push({ station, config });
      return Promise.resolve({ accountId: 'acct-g1', activated: true });
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
  process.env.METRO_GMAIL_AUTH_URL = AUTH;
  process.env.METRO_GMAIL_TOKEN_URL = TOKEN;
  process.env.METRO_GMAIL_API_URL = API;
  delete process.env.METRO_GMAIL_REDIRECT;
  tokenAnswer = json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
  profile = json({ emailAddress: 'Admin@Snapshot.org', historyId: '100' });
  exchanges = [];
  stored = [];
  globalThis.fetch = fakeGoogle as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('connecting Gmail through the Google sign-in page', () => {
  test('gmail is an interactive station', () => {
    expect(isInteractiveStation('gmail')).toBe(true);
  });

  test('start answers the browser step with an offline, consent, PKCE link back to metro.box', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'gmail', { ...CLIENT, mailbox: ' Admin@Snapshot.org ' });
    expect(started).toMatchObject({ status: 'pending', step: 'browser' });
    expect(started.authorizeUrl?.startsWith(`${AUTH}?`)).toBe(true);
    const q = query(started);
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: CLIENT.clientId,
      redirect_uri: 'https://metro.box/',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'select_account consent',
      code_challenge_method: 'S256',
      login_hint: 'admin@snapshot.org',
    });
    expect(q.get('client_secret')).toBeNull();
    await s.stop();
  });

  test('a missing or malformed client is refused before any sign-in', async () => {
    const s = sessions();
    await expect(s.start(ADA, 'gmail', { clientSecret: 'x' })).rejects.toThrow('apps.googleusercontent.com');
    await expect(s.start(ADA, 'gmail', { clientId: CLIENT.clientId })).rejects.toThrow('client secret');
    await s.stop();
  });

  test('the code is exchanged with the secret and the verifier, and the client is stored with the tokens', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'gmail', CLIENT);
    const q = query(started);
    await s.submit(ADA, started.attachId, { code: 'the-code', state: q.get('state') });
    const done = await settle(s, started.attachId);
    expect(done).toMatchObject({ status: 'done', accountId: 'acct-g1', identity: { email: 'admin@snapshot.org' } });
    const sent = exchanges[0];
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('client_secret')).toBe(CLIENT.clientSecret);
    expect(sent?.get('redirect_uri')).toBe('https://metro.box/');
    expect(createHash('sha256').update(sent?.get('code_verifier') ?? '').digest('base64url')).toBe(q.get('code_challenge') ?? '');
    expect(stored[0]).toMatchObject({
      station: 'gmail',
      config: { accountEmail: 'admin@snapshot.org', ...CLIENT, refreshToken: 'rt', accessToken: 'at' },
    });
    await s.stop();
  });

  test('another mailbox than the one named is refused and nothing is stored', async () => {
    profile = json({ emailAddress: 'fabien@snapshot.org' });
    const s = sessions();
    const started = await s.start(ADA, 'gmail', { ...CLIENT, mailbox: 'admin@snapshot.org' });
    await s.submit(ADA, started.attachId, { code: 'c', state: query(started).get('state') });
    const failed = await settle(s, started.attachId);
    expect(failed.error).toBe(
      "You signed in as fabien@snapshot.org, not admin@snapshot.org. Nothing was connected. Start again and pick admin@snapshot.org on Google's page.",
    );
    expect(stored).toEqual([]);
    await s.stop();
  });

  test('Google refusals become plain sentences', async () => {
    tokenAnswer = json({ error: 'invalid_client', error_description: 'Unauthorized' }, 401);
    const s = sessions();
    const started = await s.start(ADA, 'gmail', CLIENT);
    await s.submit(ADA, started.attachId, { code: 'c', state: query(started).get('state') });
    expect((await settle(s, started.attachId)).error).toContain('does not accept this client ID and secret');

    const again = await s.start(ADA, 'gmail', CLIENT);
    await s.submit(ADA, again.attachId, { state: query(again).get('state'), error: 'access_denied' });
    expect((await settle(s, again.attachId)).error).toContain('declined');
    await s.stop();
  });

  test('a disabled Gmail API says so', async () => {
    profile = json({ error: { status: 'PERMISSION_DENIED', message: 'Gmail API has not been used in project 1 before or it is disabled.' } }, 403);
    const s = sessions();
    const started = await s.start(ADA, 'gmail', CLIENT);
    await s.submit(ADA, started.attachId, { code: 'c', state: query(started).get('state') });
    const failed = await settle(s, started.attachId);
    expect(failed.error).toContain('Gmail API has not been used');
    expect(failed.error).toContain('Check that the Gmail API is enabled');
    await s.stop();
  });

  test('there is no code fallback for Google', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'gmail', CLIENT);
    await expect(s.submit(ADA, started.attachId, { mode: 'device' })).rejects.toThrow('another attempt');
    await s.stop();
  });
});
