import { describe, expect, test } from 'bun:test';
import { dollarsWords, toModelUsage } from '../src/api/gateway-usage.js';

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
