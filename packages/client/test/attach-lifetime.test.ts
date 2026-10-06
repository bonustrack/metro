import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AttachLifetime } from '../src/api/attach-lifetime.js';
import { toSession } from '../src/api/attach-session.js';
import { rememberSignIn } from '../src/api/sign-in-return.js';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue, readItem } from '../src/platform.js';
import { TEST_ORGANIZATION, installTestAccount } from './account-fixture.js';

const BASE = 'https://synthetic-box.example/api/agents';
const AGENT = 'synthetic-agent';
const PENDING = { attachId: 'pending', station: 'gmail', status: 'pending', step: 'browser' };
const realFetch = globalThis.fetch;
const seen: { url: string; method: string; body: unknown }[] = [];
let respond: () => Promise<Response>;

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
  seen.length = 0;
  respond = () => Promise.resolve(Response.json(PENDING));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null });
    return init?.method === 'POST' ? respond() : Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue() });
});

const cancelled = (): string[] => seen.filter((call) => call.method === 'DELETE').map((call) => call.url);

const remember = (): void => {
  rememberSignIn({ state: 'state', agentsBase: BASE, agentId: AGENT, attachId: 'pending', backHash: '#/channels', startedAt: Date.now(), identity: { user: 'user_1', organization: TEST_ORGANIZATION, session: 'session_1' } });
};

describe('attach modal lifetime', () => {
  test('closing an active pending session cancels it once at the original daemon', async () => {
    const life = new AttachLifetime(AGENT, BASE);
    await life.start('gmail', { mode: 'managed', sendEnabled: 'false' });
    remember();
    await life.close();
    await life.close();
    expect(cancelled()).toEqual([`${BASE}/${AGENT}/accounts/pending`]);
    expect(readItem('metro.outlook.pending')).toBeNull();
    expect(life.update(toSession(PENDING))).toBe(false);
  });

  test('a start that resolves after close is cancelled instead of reopening the modal', async () => {
    const response = Promise.withResolvers<Response>();
    respond = () => response.promise;
    const life = new AttachLifetime(AGENT, BASE);
    const started = life.start('gmail', { mode: 'managed', sendEnabled: 'false' });
    await life.close();
    response.resolve(Response.json(PENDING));
    expect(await started).toBeNull();
    expect(cancelled()).toEqual([`${BASE}/${AGENT}/accounts/pending`]);
  });

  test('an observed successful session is never cancelled or overwritten by a late poll', async () => {
    const life = new AttachLifetime(AGENT, BASE);
    await life.start('gmail', { mode: 'upgrade', accountId: 'existing', sendEnabled: 'true' });
    expect(life.update(toSession({ ...PENDING, status: 'done' }))).toBe(true);
    expect(life.update(toSession(PENDING))).toBe(false);
    await life.close();
    expect(cancelled()).toEqual([]);
    expect(seen[0]?.body).toEqual({ station: 'gmail', mode: 'upgrade', accountId: 'existing', sendEnabled: 'true' });
    expect(seen).toHaveLength(1);
  });

  test('a successful late start is not destroyed', async () => {
    const response = Promise.withResolvers<Response>();
    respond = () => response.promise;
    const life = new AttachLifetime(AGENT, BASE);
    const started = life.start('gmail', { mode: 'managed', sendEnabled: 'false' });
    await life.close();
    response.resolve(Response.json({ ...PENDING, status: 'done' }));
    expect(await started).toBeNull();
    expect(cancelled()).toEqual([]);
  });

  test('a completed one-shot result or failed session is not cancelled', async () => {
    for (const body of [{ accountId: 'connected', identity: {} }, { ...PENDING, status: 'failed' }]) {
      respond = () => Promise.resolve(Response.json(body));
      const life = new AttachLifetime(AGENT, BASE);
      await life.start('gmail', {});
      await life.close();
    }
    expect(cancelled()).toEqual([]);
  });

  test('closing before a click prevents a start', async () => {
    const life = new AttachLifetime(AGENT, BASE);
    await life.close();
    expect(await life.start('gmail', {})).toBeNull();
    expect(seen).toEqual([]);
  });
});
