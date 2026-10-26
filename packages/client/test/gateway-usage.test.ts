import { describe, expect, test } from 'bun:test';
import { dollarsWords, toGatewayWindows, toModelUsage, withGatewayWindows } from '../src/api/gateway-usage.js';

describe('reading the model usage answer', () => {
  test('keeps what it can read, drops broken rows, and zeroes what is missing', () => {
    const usage = toModelUsage({
      range: '7d',
      bucketMs: 21_600_000,
      buckets: [{ at: 1, calls: 3, failed: 1, spendMicros: 2500, byConnection: { conn0000001: { calls: 3, spendMicros: 2500 } } }, { calls: 2 }],
      connections: [{ connection: 'conn0000001', provider: 'anthropic', label: 'Team', calls: 3, spendMicros: 2500, unpriced: 1, cacheReadTokens: 900 }, { label: 'no id' }],
      agents: [{ agent: 'agent000001', name: null, calls: 3, spendMicros: 2500 }],
      totals: { calls: 3, spendMicros: 2500, p50FirstTokenMs: 410, p95FirstTokenMs: -1 },
    });
    expect(usage.buckets).toEqual([{ at: 1, calls: 3, failed: 1, spendMicros: 2500, byConnection: { conn0000001: { calls: 3, spendMicros: 2500 } } }]);
    expect(usage.connections).toEqual([{ connection: 'conn0000001', provider: 'anthropic', label: 'Team', calls: 3, spendMicros: 2500, failed: 0, unpriced: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 0 }]);
    expect(usage.agents).toEqual([{ agent: 'agent000001', name: null, calls: 3, spendMicros: 2500 }]);
    expect(usage.totals).toMatchObject({ calls: 3, spendMicros: 2500, failed: 0, p50FirstTokenMs: 410, p95FirstTokenMs: null });
  });

  test('refuses an answer that is not usage', () => {
    expect(() => toModelUsage({ range: '1y', buckets: [] })).toThrow('unexpected response');
    expect(() => toModelUsage(null)).toThrow('unexpected response');
  });

  test('spend reads in dollars, with cents', () => {
    expect([0, 4000, 10_000, 2_294_000, 1_234_567_890].map(dollarsWords)).toEqual(['$0', '< $0.01', '$0.01', '$2.29', '$1,234.57']);
  });
});

describe('rate-limit windows from api.metro.box', () => {
  const at = Date.UTC(2026, 9, 26, 10);
  const windows = toGatewayWindows({
    windows: [
      { connection: 'conn0000001', label: '5-hour', used: 1.4, resetAt: at + 3_600_000, detail: null, at },
      { connection: 'conn0000001', label: 'Weekly', used: 0.2, resetAt: null, detail: 'Sonnet', at: at - 60_000 },
      { connection: 'conn0000002', label: 'no time' },
      { label: 'no connection', at },
    ],
  });

  test('keeps the readable windows, the share between 0 and 1, the reset as a date', () => {
    expect(windows).toEqual([
      { connection: 'conn0000001', label: '5-hour', used: 1, resetAt: new Date(at + 3_600_000).toISOString(), detail: null, at },
      { connection: 'conn0000001', label: 'Weekly', used: 0.2, resetAt: null, detail: 'Sonnet', at: at - 60_000 },
    ]);
    expect(toGatewayWindows(null)).toEqual([]);
  });

  test('fills in the box usage per connection: the gateway wins a window of the same name, the box keeps its others and its tally', () => {
    const tally = { requests: 2, input: 10, output: 5, cached: 0, since: '2026-10-26T00:00:00.000Z' };
    const box = {
      conn0000001: { windows: [{ label: '5-hour', used: 0.1, resetAt: null, detail: null }, { label: 'Credits', used: null, resetAt: null, detail: '$4 left' }], note: null, at: '2026-10-26T09:00:00.000Z', tally },
      conn0000003: { windows: [], note: 'kept', at: '2026-10-26T09:00:00.000Z', tally: null },
    };
    const merged = withGatewayWindows(box, windows);
    expect(merged.conn0000001?.windows.map((w) => [w.label, w.used])).toEqual([['5-hour', 1], ['Weekly', 0.2], ['Credits', null]]);
    expect(merged.conn0000001?.at).toBe(new Date(at).toISOString());
    expect(merged.conn0000001?.tally).toEqual(tally);
    expect(merged.conn0000003).toEqual(box.conn0000003);
    expect(withGatewayWindows(box, [])).toBe(box);
    expect(withGatewayWindows({}, windows).conn0000001?.windows).toHaveLength(2);
  });
});
