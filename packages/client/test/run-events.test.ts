import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { getRunEvents, RUN_EVENTS_SINCE, RunEventsUnavailableError, type RunEvent, type RunEventsPage } from '../src/api/run-events.js';
import { AuthError, ForbiddenError } from '../src/api/client.js';
import { installTestAccount } from './account-fixture.js';

const AGENT = 'agent000001';
const realFetch = globalThis.fetch;
let calls: { url: string; authorization: string | null; method: string | undefined }[] = [];
const row: RunEvent = {
  id: 'event-1', seq: 1, ts: '2026-10-05T19:00:00.000Z', kind: 'msg', direction: 'inbound', agentId: AGENT,
  station: 'whatsapp', accountId: 'account-1', line: 'metro://whatsapp/account-1/chat', from: 'metro://whatsapp/account-1/user/alice',
  text: 'Hello', truncated: false, metadata: { attachmentCount: 1, attachmentTypes: ['image'] },
};
const page: RunEventsPage = { events: [row], cursor: 'cursor-1', hasMore: false, reset: true, retention: { capacity: 500, oldestAt: row.ts, oldestSeq: 1 } };

function serve(body: unknown, status = 200, headStatus = 405): void {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), method: init?.method });
    return Promise.resolve(init?.method === 'HEAD' ? new Response(null, { status: headStatus }) : Response.json(body, { status }));
  }, { preconnect: realFetch.preconnect });
}

beforeEach(() => {
  calls = [];
  installTestAccount();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
});

describe('getRunEvents', () => {
  test('reuses browser bearer calls and carries only scoped bounded query fields', async () => {
    serve(page);
    expect(await getRunEvents(AGENT, { cursor: 'opaque:cursor', limit: 500, version: RUN_EVENTS_SINCE })).toEqual(page);
    const sent = calls[0];
    expect(sent?.method).toBe('GET');
    expect(sent?.authorization).toStartWith('Bearer ');
    const url = new URL(sent?.url ?? '');
    expect(url.pathname).toBe('/api/run/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({ agent: AGENT, limit: '500', cursor: 'opaque:cursor' });
    expect(url.searchParams.has('token')).toBe(false);
  });

  test('does not contact an old daemon monitor catchall or pretend missing support is an empty feed', async () => {
    serve(page);
    await expect(getRunEvents(AGENT, { version: '0.1.0-beta.262' })).rejects.toBeInstanceOf(RunEventsUnavailableError);
    expect(calls).toEqual([]);
    serve({ error: 'not found' }, 404);
    await expect(getRunEvents(AGENT)).rejects.toBeInstanceOf(RunEventsUnavailableError);
    serve(page);
    expect(await getRunEvents(AGENT, { version: null })).toEqual(page);
  });

  test('unknown-version old monitor responses are unavailable without bearer requests or refresh', async () => {
    for (const version of [undefined, null, 'unknown']) {
      for (const status of [401, 404]) {
        calls = [];
        serve({}, 401, status);
        await expect(getRunEvents(AGENT, { version })).rejects.toBeInstanceOf(RunEventsUnavailableError);
        expect(calls.map((entry) => [new URL(entry.url).pathname, entry.method, entry.authorization])).toEqual([['/api/run/events', 'HEAD', null]]);
      }
    }
    calls = [];
    serve(page);
    expect(await getRunEvents(AGENT, { version: null })).toEqual(page);
    expect(calls.map((entry) => entry.method)).toEqual(['HEAD', 'GET']);
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[1]?.authorization).toStartWith('Bearer ');
    serve({}, 500, 500);
    await expect(getRunEvents(AGENT)).rejects.toThrow('checking Run events support');
  });

  test('keeps authorization failures distinct from unsupported daemons', async () => {
    clearAccount();
    serve(page);
    await expect(getRunEvents(AGENT)).rejects.toBeInstanceOf(AuthError);
    expect(calls).toEqual([]);
    installTestAccount();
    serve({ error: 'another organization' }, 403);
    await expect(getRunEvents(AGENT, { version: RUN_EVENTS_SINCE })).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls.map((entry) => entry.method)).toEqual(['GET']);
    await expect(getRunEvents(AGENT)).rejects.toThrow('another organization');
    serve({ error: 'no such agent' }, 404);
    await expect(getRunEvents(AGENT)).rejects.toThrow('no such agent');
  });

  test('rejects malformed, overlarge, cross-agent or unordered responses', async () => {
    for (const body of [
      null, {}, { ...page, cursor: null }, { ...page, cursor: 'x'.repeat(129) }, { ...page, events: Array.from({ length: 501 }, () => row) },
      { ...page, events: [{ ...row, text: 'x'.repeat(8_001) }] }, { ...page, events: [{ ...row, kind: 'unknown' }] },
      { ...page, events: [{ ...row, direction: 'guessed' }] }, { ...page, events: [{ ...row, agentId: 'agent000002' }] },
      { ...page, events: [{ ...row, metadata: { token: 'secret', attachmentTypes: ['unknown'] } }] },
      { ...page, events: [row, row] }, { ...page, retention: { capacity: 500, oldestAt: null } },
      { ...page, events: [{ ...row, metadata: { token: 'secret' } }] }, { ...page, events: [{ ...row, payload: { authorization: 'secret' } }] },
      { ...page, retention: { ...page.retention, token: 'secret' } }, { ...page, credentials: 'secret' },
    ]) {
      serve(body);
      await expect(getRunEvents(AGENT)).rejects.toThrow('unexpected Run events');
    }
  });
});
