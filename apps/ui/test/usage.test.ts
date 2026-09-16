import { describe, expect, test } from 'bun:test';
import { percentLabel, tallyLine, tokensLabel, toUsage, untilLabel, windowLine } from '../src/api/usage.js';

const NOW = Date.parse('2026-09-17T10:00:00.000Z');

describe('what the page makes of the usage the daemon reports', () => {
  test('known providers come through, unknown ones and malformed entries are dropped', () => {
    const usage = toUsage({
      anthropic: { windows: [{ label: '5-hour window', used: 0.34, resetAt: '2026-09-17T12:30:00.000Z', detail: null }], note: null, at: '2026-09-17T09:58:00.000Z' },
      codex: { windows: [{ label: 'Weekly', used: 1.4, resetAt: null, detail: null }], note: 'usage limit reached', at: '2026-09-17T09:59:00.000Z' },
      bedrock: { windows: [{ label: 'x', used: 0.1 }] },
      openrouter: { windows: [], at: 'now' },
      nonsense: 7,
    });
    expect(Object.keys(usage).sort()).toEqual(['anthropic', 'codex']);
    expect(usage.codex?.windows[0]?.used).toBe(1);
    expect(usage.codex?.note).toBe('usage limit reached');
    expect(toUsage(null)).toEqual({});
  });

  test('a window reads as one line: percent, detail, reset', () => {
    expect(windowLine({ label: 'x', used: 0.34, resetAt: '2026-09-17T12:30:00.000Z', detail: null }, NOW)).toBe('34% used · resets in 2 h 30 min');
    expect(windowLine({ label: 'x', used: 0.248, resetAt: null, detail: '$12.40 of $50.00 used' }, NOW)).toBe('25% used · $12.40 of $50.00 used');
    expect(windowLine({ label: 'x', used: null, resetAt: null, detail: '$0.00 of $0.00 used' }, NOW)).toBe('$0.00 of $0.00 used');
    expect(percentLabel(0.999)).toBe('100% used');
    expect(percentLabel(0.003)).toBe('0.3% used');
    expect(percentLabel(0)).toBe('0% used');
  });

  test('a provider with only a token count still shows, and the count reads in k and M', () => {
    const usage = toUsage({
      bedrock: { windows: [], note: null, at: '2026-09-17T09:00:00.000Z', tally: { requests: 14, input: 128_400, output: 9_050, cached: 96_000, since: '2026-09-17T08:00:00.000Z' } },
    });
    expect(usage.bedrock?.windows).toEqual([]);
    expect(tallyLine(usage.bedrock?.tally ?? { requests: 0, input: 0, output: 0, cached: 0, since: '' })).toBe('14 requests · 128k in · 9.1k out · 96k cached');
    expect(tallyLine({ requests: 1, input: 900, output: 12, cached: 0, since: '' })).toBe('1 request · 900 in · 12 out');
    expect(tokensLabel(2_400_000)).toBe('2.4M');
    expect(tokensLabel(12_000_000)).toBe('12M');
  });

  test('a reset in the future is said in the units a person would use', () => {
    expect(untilLabel('2026-09-17T10:05:00.000Z', NOW)).toBe('resets in 5 min');
    expect(untilLabel('2026-09-17T13:00:00.000Z', NOW)).toBe('resets in 3 h');
    expect(untilLabel('2026-09-17T09:00:00.000Z', NOW)).toBe('resets now');
    expect(untilLabel('2026-09-19T09:00:00.000Z', NOW)).toMatch(/^resets \w{3} /);
    expect(untilLabel('soon', NOW)).toBe('');
  });
});
