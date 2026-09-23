import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AttachSessions, type AttachOwner, type AttachView } from '../src/stations/attach-session.ts';
import { isInteractiveStation } from '../src/stations/attach-interactive.ts';

const LOGIN = 'https://login.test/common';
const GRAPH = 'https://graph.test/v1.0';
const ADA: AttachOwner = { agentId: 'agent000001' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let tokenAnswers: Response[] = [];
let stored: { station: string; config: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

function fakeMicrosoft(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url === `${LOGIN}/oauth2/v2.0/devicecode`)
    return Promise.resolve(json({ device_code: 'dc', user_code: 'XK7P9QRT', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 0 }));
  if (url === `${LOGIN}/oauth2/v2.0/token`) return Promise.resolve(tokenAnswers.shift() ?? json({ error: 'authorization_pending' }, 400));
  if (url.startsWith(`${GRAPH}/me?`)) return Promise.resolve(json({ mail: 'Andy@Anderra.ch', displayName: 'Andy' }));
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

beforeEach(() => {
  process.env.METRO_OUTLOOK_LOGIN_URL = LOGIN;
  process.env.METRO_OUTLOOK_GRAPH_URL = GRAPH;
  process.env.METRO_OUTLOOK_CLIENT_ID = 'test-client';
  tokenAnswers = [];
  stored = [];
  globalThis.fetch = fakeMicrosoft as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('connecting Outlook with a Microsoft sign-in code', () => {
  test('outlook is an interactive station', () => {
    expect(isInteractiveStation('outlook')).toBe(true);
  });

  test('start shows the code, the page polls, and the account is stored once Microsoft says yes', async () => {
    tokenAnswers = [json({ error: 'authorization_pending' }, 400), json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    expect(started).toMatchObject({ status: 'pending', step: 'device', userCode: 'XK7P9QRT', verificationUri: 'https://microsoft.com/devicelogin' });
    expect(started.expiresAt).toBeGreaterThan(Date.now() + 10 * 60_000);
    const done = await settle(s, started.attachId);
    expect(done).toMatchObject({ status: 'done', accountId: 'acct-o1', identity: { email: 'andy@anderra.ch', name: 'Andy' }, userCode: null });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.station).toBe('outlook');
    expect(stored[0]?.config).toMatchObject({ accountEmail: 'andy@anderra.ch', refreshToken: 'rt', accessToken: 'at' });
    await s.stop();
  });

  test('an organization that has not approved Metro fails with the admin sentence and stores nothing', async () => {
    tokenAnswers = [json({ error: 'invalid_grant', error_description: 'AADSTS65001: consent required' }, 400)];
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    const failed = await settle(s, started.attachId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('must approve Metro once');
    expect(stored).toEqual([]);
    await s.stop();
  });

  test('there is nothing to submit on this sign-in', async () => {
    const s = sessions();
    const started = await s.start(ADA, 'outlook', {});
    await expect(s.submit(ADA, started.attachId, { code: '1' })).rejects.toThrow('finishes on the Microsoft page');
    await s.cancel(ADA, started.attachId);
    await s.stop();
  });
});
