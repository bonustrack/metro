import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { fetchConnectorStats, isFilterable, OTHER_CONNECTORS, toConnectorStats } from '../src/api/connector-stats.js';
import { installTestAccount } from './account-fixture.js';

const BASE = 'https://api.metro.box/api/connectors/activity/stats';
const realFetch = globalThis.fetch;
const AT = Date.parse('2026-10-22T06:00:00.000Z');

let urls: string[] = [];

function serve(body: unknown, status = 200): void {
  urls = [];
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

const ANSWER = {
  range: '7d',
  bucketMs: 21_600_000,
  buckets: [{ at: AT, total: 5, failed: 1, byConnector: { cN3_xYz9Qw0: { total: 4, failed: 1 }, jira: { total: 1 } } }],
  connectors: [{ key: 'cN3_xYz9Qw0', connector: 'cN3_xYz9Qw0', name: 'Notion', url: 'https://mcp.notion.com', total: 4, failed: 1 }, { key: 'jira', name: 'jira', total: 1, failed: 0 }],
  totals: { total: 5, ok: 3, failed: 1, blocked: 1, denied: 0, waiting: 0, p50Ms: 120, p95Ms: 900 },
};

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

describe('reading the connector call stats', () => {
  test('an answer is read as sent, with safe defaults for what is missing or broken', () => {
    expect(toConnectorStats(ANSWER)).toEqual({
      range: '7d',
      bucketMs: 21_600_000,
      buckets: [{ at: AT, total: 5, failed: 1, byConnector: { cN3_xYz9Qw0: { total: 4, failed: 1 }, jira: { total: 1, failed: 0 } } }],
      connectors: [
        { key: 'cN3_xYz9Qw0', connector: 'cN3_xYz9Qw0', name: 'Notion', url: 'https://mcp.notion.com', total: 4, failed: 1 },
        { key: 'jira', connector: null, name: 'jira', url: null, total: 1, failed: 0 },
      ],
      totals: { total: 5, ok: 3, failed: 1, blocked: 1, denied: 0, waiting: 0, p50Ms: 120, p95Ms: 900 },
    });
    const broken = toConnectorStats({ range: '24h', bucketMs: 'x', buckets: [{ at: 'soon' }, { at: AT, total: -3, failed: 1.7 }], connectors: [{ name: 'no key' }], totals: { p50Ms: -1 } });
    expect(broken).toEqual({
      range: '24h',
      bucketMs: 0,
      buckets: [{ at: AT, total: 0, failed: 1, byConnector: {} }],
      connectors: [],
      totals: { total: 0, ok: 0, failed: 0, blocked: 0, denied: 0, waiting: 0, p50Ms: null, p95Ms: null },
    });
    for (const bad of [null, [], { range: '1y', buckets: [] }, { range: '7d' }]) expect(() => toConnectorStats(bad)).toThrow('unexpected response');
  });

  test('the range, agent and connector reach the url', async () => {
    serve(ANSWER);
    await fetchConnectorStats({ range: '30d' });
    await fetchConnectorStats({ range: '7d', agent: 'aB3-_xYz9Qw', connector: null });
    await fetchConnectorStats({ range: '24h', agent: null, connector: 'jira' });
    expect(urls).toEqual([`${BASE}?range=30d`, `${BASE}?range=7d&agent=aB3-_xYz9Qw`, `${BASE}?range=24h&connector=jira`]);
  });

  test('an api.metro.box without the route answers no stats rather than an error', async () => {
    serve({ error: 'not found' }, 404);
    expect(await fetchConnectorStats({ range: '7d' })).toBeNull();
    serve({ error: 'boom' }, 500);
    await expect(fetchConnectorStats({ range: '7d' })).rejects.toThrow('boom');
  });

  test('Other and a call that named no connector cannot be picked as a filter', () => {
    const row = { connector: null, name: '', url: null, total: 1, failed: 0 };
    expect(isFilterable({ ...row, key: 'jira' })).toBe(true);
    expect(isFilterable({ ...row, key: OTHER_CONNECTORS })).toBe(false);
    expect(isFilterable({ ...row, key: '' })).toBe(false);
  });
});
