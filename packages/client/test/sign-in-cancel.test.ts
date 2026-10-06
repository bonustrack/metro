import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { finishReturn, forgetAttachSignIn, rememberSignIn, type PendingSignIn } from '../src/api/sign-in-return.js';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, location, memoryKeyValue, readItem } from '../src/platform.js';
import { TEST_ORGANIZATION, installTestAccount } from './account-fixture.js';

const now = Date.now();
const entry: PendingSignIn = { state: 'synthetic-state', agentsBase: 'https://synthetic-box.example/api/agents', agentId: 'agent', attachId: 'attach', backHash: '#/channels', startedAt: now, identity: { user: 'user_1', organization: TEST_ORGANIZATION, session: 'session_1' } };
const realFetch = globalThis.fetch;
const realLocation = location();
const events: string[] = [];
let posted: unknown = null;

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), location: { ...realLocation, clearSearch: (query) => { events.push(`clear:${query}`); } } });
  installTestAccount();
  events.length = 0;
  posted = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    events.push(`${init?.method ?? 'GET'}:${url}`);
    posted = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    return Response.json({ attachId: 'attach', station: 'gmail', status: 'done' });
  }) as typeof fetch;
});

afterEach(() => {
  clearAccount();
  globalThis.fetch = realFetch;
  configurePlatform({ kv: memoryKeyValue(), location: realLocation });
});

describe('shared Gmail and Outlook callback', () => {
  test('strips code query before exchanging and consumes local state once', async () => {
    rememberSignIn(entry);
    const ret = { kind: 'code', code: 'synthetic-code', state: entry.state } as const;
    expect(await finishReturn(ret, now)).toEqual({ ok: true, station: 'gmail' });
    expect(events).toEqual(['clear:', `POST:${entry.agentsBase}/agent/accounts/attach/step`]);
    expect(posted).toEqual({ code: 'synthetic-code', state: entry.state });
    expect(readItem('metro.outlook.pending')).toBeNull();
    expect((await finishReturn(ret, now)).ok).toBe(false);
    expect(events.filter((event) => event.startsWith('POST'))).toHaveLength(1);
  });

  test('a cancelled session cannot post a callback code', async () => {
    rememberSignIn(entry);
    forgetAttachSignIn(entry.agentsBase, entry.agentId, entry.attachId);
    expect((await finishReturn({ kind: 'code', code: 'synthetic-code', state: entry.state }, now)).ok).toBe(false);
    expect(events).toEqual(['clear:']);
    expect(posted).toBeNull();
  });

  test('cancelling one sign-in does not erase another daemon or account session', async () => {
    rememberSignIn(entry);
    rememberSignIn({ ...entry, agentsBase: 'https://another-box.example/api/agents', state: 'other-box' });
    rememberSignIn({ ...entry, agentId: 'other-agent', state: 'other-agent' });
    rememberSignIn({ ...entry, attachId: 'other-attach', state: 'other-attach' });
    forgetAttachSignIn(entry.agentsBase, entry.agentId, entry.attachId);
    const pending = readItem('metro.outlook.pending');
    expect(pending).not.toContain('synthetic-state');
    expect(pending).toContain('other-box');
    expect(pending).toContain('other-agent');
    expect(pending).toContain('other-attach');
  });
});
