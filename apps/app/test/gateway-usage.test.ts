import { describe, expect, test } from 'bun:test';
import { toModelUsage } from '@metro-labs/client/api/gateway-usage';
import { routeHash, routeSelection } from '@metro-labs/client/route';
import { connectionName, secondsWords, usageMeasure, usageSeries, usageTiles } from '../src/lib/gateway-usage.ts';

const usage = toModelUsage({
  range: '7d',
  bucketMs: 21_600_000,
  buckets: [
    { at: 0, calls: 2, failed: 0, spendMicros: 3000, byConnection: { conn0000001: { calls: 1, spendMicros: 1000 }, conn0000002: { calls: 1, spendMicros: 2000 } } },
    { at: 21_600_000, calls: 1, failed: 1, spendMicros: 0, byConnection: { '~other': { calls: 1, spendMicros: 0 } } },
  ],
  connections: [
    { connection: 'conn0000002', provider: 'openrouter', label: 'OpenRouter', calls: 1, spendMicros: 2000 },
    { connection: 'conn0000001', provider: 'anthropic', label: null, calls: 1, spendMicros: 1000 },
  ],
  agents: [],
  totals: { calls: 3, ok: 2, failed: 1, limited: 0, spendMicros: 3000, unpriced: 2, inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, p50FirstTokenMs: 640, p95FirstTokenMs: 2300 },
});

describe('the Gateway usage view', () => {
  test('the tiles say spend, calls, tokens and the first token in words', () => {
    expect(usageTiles(usage.totals, '7d').map((tile) => [tile.label, tile.value, tile.detail, tile.danger])).toEqual([
      ['Spend', '< $0.01', '2 calls on a plan or with no list price', false],
      ['Model calls', '3', '33% failed, 0 over a limit', true],
      ['Tokens in', '1,000', '90% read from the cache', false],
      ['Tokens out', '50', 'Written by the models', false],
      ['First token', '640 ms', 'Typical. Slowest 5%: 2.3 s', false],
    ]);
    expect(secondsWords(null)).toBe('No answer yet');
  });

  test('the chart stacks spend per account in spend order, Other last, and falls back to calls with no spend', () => {
    const series = usageSeries(usage, usageMeasure(usage), { slots: ['red', 'blue'], other: 'grey' });
    expect(series.map((one) => [one.key, one.label, one.color, one.values])).toEqual([
      ['conn0000002', 'OpenRouter', 'red', [2000, 0]],
      ['conn0000001', 'Removed anthropic account', 'blue', [1000, 0]],
      ['~other', 'Other accounts', 'grey', [0, 0]],
    ]);
    expect(usageMeasure({ ...usage, totals: { ...usage.totals, spendMicros: 0 } })).toBe('calls');
    expect(connectionName({ connection: '', label: null, provider: null })).toBe('No model set up');
  });

  test('the Usage page has its own address under the Gateway', () => {
    expect(routeSelection('#/organization/models/usage')).toEqual({ kind: 'org-usage' });
    expect(routeHash({ kind: 'org-usage' })).toContain('organization/models/usage');
  });
});
