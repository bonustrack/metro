import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import {
  ACTIVITY_LATE_MS, ACTIVITY_LIVE_MAX, ACTIVITY_PAGE, emptyFeed, feedReducer, feedSince, fetchConnectorActivity, oldestCall, toActivityCall, type ActivityCall, type ActivityFeed,
} from '../src/api/connector-activity.js';
import { installTestAccount } from './account-fixture.js';

const BASE = 'https://api.metro.box/api/connectors/activity';
const realFetch = globalThis.fetch;
const NOW = Date.parse('2026-10-22T09:00:00.000Z');

let urls: string[] = [];

function serve(body: unknown, status = 200): void {
  urls = [];
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

const call = (id: string, at: number, patch: Partial<ActivityCall> = {}): ActivityCall => ({
  id, agent: 'aB3-_xYz9Qw', agentName: 'Emma', connector: 'cN3-_xYz9Qw', connectorKey: 'notion', connectorName: 'Notion', connectorUrl: 'https://mcp.notion.com', tool: 'search', outcome: 'ok', ms: 12, at, ...patch,
});

const ids = (feed: ActivityFeed): string[] => feed.calls.map((one) => one.id);

const run = (feed: ActivityFeed, ...actions: Parameters<typeof feedReducer>[1][]): ActivityFeed => actions.reduce(feedReducer, feed);

beforeAll(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  clearAccount();
});

describe('reading the connector activity', () => {
  test('a row is read with safe defaults, and a row without an id, agent, tool or time is dropped', () => {
    expect(toActivityCall({ id: 'a', agent: 'b', tool: 'search', at: NOW, ms: -4, connector: null, connectorKey: 'jira' })).toEqual({
      id: 'a', agent: 'b', agentName: null, connector: null, connectorKey: 'jira', connectorName: null, connectorUrl: null, tool: 'search', outcome: '', ms: 0, at: NOW,
    });
    for (const bad of [null, { agent: 'b', tool: 't', at: 1 }, { id: 'a', tool: 't', at: 1 }, { id: 'a', agent: 'b', at: 1 }, { id: 'a', agent: 'b', tool: 't', at: 'soon' }]) expect(toActivityCall(bad)).toBeNull();
  });

  test('a page keeps the rows it can read, and before carries the time and id of the oldest call', async () => {
    serve({ calls: [call('one', NOW), { broken: true }] });
    expect(await fetchConnectorActivity({ limit: 50 })).toEqual([call('one', NOW)]);
    expect(urls).toEqual([`${BASE}?limit=50`]);
    serve({ calls: [] });
    await fetchConnectorActivity({ limit: 50, before: call('zZ9-_xYz9Qw', NOW - 1), agent: null });
    expect(urls).toEqual([`${BASE}?limit=50&before=${String(NOW - 1)}%3AzZ9-_xYz9Qw`]);
  });

  test('since and agent reach the url', async () => {
    serve({ calls: [] });
    await fetchConnectorActivity({ limit: 200, since: NOW - 10_000.5, agent: 'aB3-_xYz9Qw' });
    expect(urls).toEqual([`${BASE}?limit=200&since=${String(NOW - 10_001)}&agent=aB3-_xYz9Qw`]);
  });

  test('an api.metro.box without the route answers no activity rather than an error', async () => {
    serve({ error: 'not found' }, 404);
    expect(await fetchConnectorActivity({ limit: 50 })).toBeNull();
    serve({ error: 'boom' }, 500);
    await expect(fetchConnectorActivity({ limit: 50 })).rejects.toThrow('boom');
    serve({ nothing: true });
    await expect(fetchConnectorActivity({ limit: 50 })).rejects.toThrow('unexpected response');
  });
});

describe('the live feed', () => {
  test('the first page fills the feed newest first, and says whether earlier calls exist', () => {
    const short = run(emptyFeed(), { type: 'newer', calls: [call('a', NOW - 2), call('b', NOW)] });
    expect(ids(short)).toEqual(['b', 'a']);
    expect(short.loaded).toBe(true);
    expect(short.complete).toBe(true);
    const full = run(emptyFeed(), { type: 'newer', calls: Array.from({ length: ACTIVITY_PAGE }, (_, i) => call(`c${String(i)}`, NOW - i)) });
    expect(full.complete).toBe(false);
    const old = run(emptyFeed(), { type: 'newer', calls: null });
    expect(old).toMatchObject({ loaded: true, complete: true, calls: [] });
  });

  test('new calls go on top once, ties are ordered by id, and since overlaps the newest call by the late window', () => {
    const first = run(emptyFeed(), { type: 'newer', calls: [call('m', NOW - 5)] });
    expect(feedSince(emptyFeed())).toBeUndefined();
    expect(feedSince(first)).toBe(NOW - 5 - ACTIVITY_LATE_MS);
    const next = run(first, { type: 'newer', calls: [call('z', NOW), call('a', NOW), call('m', NOW - 5)] });
    expect(ids(next)).toEqual(['z', 'a', 'm']);
    expect(run(next, { type: 'newer', calls: [call('z', NOW)] })).toBe(next);
    expect(feedSince(run(emptyFeed(), { type: 'newer', calls: [] }))).toBe(0);
  });

  test('while the reader is scrolled down new calls wait, and they all show once the reader is back on top', () => {
    const held = run(emptyFeed(), { type: 'newer', calls: [call('a', NOW - 10)] }, { type: 'hold', held: true }, { type: 'newer', calls: [call('b', NOW - 5), call('c', NOW)] });
    expect(ids(held)).toEqual(['a']);
    expect(held.pending.map((one) => one.id)).toEqual(['c', 'b']);
    expect(feedSince(held)).toBe(NOW - ACTIVITY_LATE_MS);
    expect(run(held, { type: 'newer', calls: [call('c', NOW)] })).toBe(held);
    const shown = run(held, { type: 'hold', held: false });
    expect(ids(shown)).toEqual(['c', 'b', 'a']);
    expect(shown.pending).toEqual([]);
    expect(shown.held).toBe(false);
  });

  test('live calls keep the newest 200, and the feed then has earlier calls to show', () => {
    const many = Array.from({ length: ACTIVITY_LIVE_MAX + 30 }, (_, i) => call(`n${String(i).padStart(3, '0')}`, NOW - i));
    const first = run(emptyFeed(), { type: 'newer', calls: many.slice(100, 120) });
    expect(first.complete).toBe(true);
    const full = run(first, { type: 'newer', calls: many.slice(0, 100) }, { type: 'newer', calls: many.slice(120) });
    expect(full.calls).toHaveLength(ACTIVITY_LIVE_MAX);
    expect(full.calls[0]?.id).toBe('n000');
    expect(full.complete).toBe(false);
  });

  test('Show earlier appends older calls below, keeps them, and stops when a page comes back short', () => {
    const first = run(emptyFeed(), { type: 'newer', calls: Array.from({ length: ACTIVITY_PAGE }, (_, i) => call(`p${String(i).padStart(3, '0')}`, NOW - i)) });
    expect(oldestCall(first)?.id).toBe('p049');
    const older = Array.from({ length: ACTIVITY_LIVE_MAX }, (_, i) => call(`q${String(i).padStart(3, '0')}`, NOW - 1_000 - i));
    const more = run(first, { type: 'older', calls: older, asked: ACTIVITY_LIVE_MAX });
    expect(more.calls).toHaveLength(ACTIVITY_PAGE + ACTIVITY_LIVE_MAX);
    expect(more.complete).toBe(false);
    const live = run(more, { type: 'newer', calls: [call('top', NOW + 1)] });
    expect(live.calls).toHaveLength(ACTIVITY_PAGE + ACTIVITY_LIVE_MAX);
    expect(live.calls[0]?.id).toBe('top');
    expect(run(more, { type: 'older', calls: [call('last', 1)], asked: ACTIVITY_PAGE }).complete).toBe(true);
    expect(run(more, { type: 'older', calls: null, asked: ACTIVITY_PAGE }).complete).toBe(true);
    expect(oldestCall(emptyFeed())).toBeUndefined();
  });
});
