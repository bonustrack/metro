import { describe, expect, test } from 'bun:test';
import {
  barLayout,
  barPath,
  dayBuckets,
  dayLabel,
  durationMs,
  formatDuration,
  formatTokens,
  median,
  peakIndex,
  summarize,
  totalTokens,
  type Run,
} from '../src/components/runs';
import { toRuns } from '../src/api/runs';

const NOW = Date.parse('2026-08-14T06:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const run = (over: Partial<Run> = {}): Run => ({
  agentId: 1,
  id: 'a1',
  type: 'worker',
  label: 'a label',
  state: 'done',
  startedAt: NOW - 2 * 60 * 1000,
  endedAt: NOW - 60 * 1000,
  turns: 4,
  inputTokens: 10,
  outputTokens: 100,
  cacheReadTokens: 1000,
  cacheWriteTokens: 10_000,
  ...over,
});

describe('one run', () => {
  test('tokens are every counter added together', () => {
    expect(totalTokens(run())).toBe(11_110);
  });

  test('a finished run is measured to its end, a running one to now', () => {
    expect(durationMs(run(), NOW)).toBe(60_000);
    expect(durationMs(run({ state: 'running', endedAt: null }), NOW)).toBe(120_000);
  });

  test('a clock that went backwards never yields a negative duration', () => {
    expect(durationMs(run({ startedAt: NOW + 5000, endedAt: NOW }), NOW)).toBe(0);
  });
});

describe('bucketing by day', () => {
  test('every day in the window gets a bar, including the empty ones', () => {
    const buckets = dayBuckets([run()], 14, NOW);
    expect(buckets).toHaveLength(14);
    expect(buckets[13]?.day).toBe('2026-08-14');
    expect(buckets[0]?.day).toBe('2026-08-01');
    expect(buckets[13]?.runs).toBe(1);
    expect(buckets[12]?.runs).toBe(0);
  });

  test('a run older than the window is left out rather than piled on day one', () => {
    const buckets = dayBuckets([run({ startedAt: NOW - 60 * DAY })], 14, NOW);
    expect(buckets.reduce((sum, b) => sum + b.runs, 0)).toBe(0);
  });

  test('a day carries its own token total and median duration', () => {
    const buckets = dayBuckets(
      [
        run({ id: 'a', endedAt: run().startedAt + 10_000 }),
        run({ id: 'b', endedAt: run().startedAt + 30_000 }),
        run({ id: 'c', endedAt: run().startedAt + 50_000 }),
      ],
      14,
      NOW,
    );
    expect(buckets[13]?.tokens).toBe(3 * 11_110);
    expect(buckets[13]?.medianMs).toBe(30_000);
  });

  test('a still-running agent counts as started but not as a duration', () => {
    const buckets = dayBuckets([run({ state: 'running', endedAt: null })], 14, NOW);
    expect(buckets[13]?.runs).toBe(1);
    expect(buckets[13]?.medianMs).toBe(0);
  });
});

describe('the summary tiles', () => {
  test('running, total, tokens and the median of what finished', () => {
    const stats = summarize(
      [
        run({ id: 'a', endedAt: run().startedAt + 10_000 }),
        run({ id: 'b', endedAt: run().startedAt + 30_000 }),
        run({ id: 'c', state: 'running', endedAt: null }),
      ],
      NOW,
    );
    expect(stats).toEqual({
      running: 1,
      runs: 3,
      tokens: 3 * 11_110,
      medianMs: 20_000,
    });
  });

  test('an even number of runs takes the mean of the middle pair', () => {
    expect(median([1, 3])).toBe(2);
    expect(median([5])).toBe(5);
    expect(median([])).toBe(0);
  });
});

describe('the bars', () => {
  test('bars sit inside the box, capped in width, and grow from the baseline', () => {
    const bars = barLayout([1, 2, 4], 300, 72);
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.width).toBeLessThanOrEqual(24);
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(300);
      expect(Math.round(bar.y + bar.height)).toBe(72);
    }
    expect(bars[2]?.height).toBe(72);
    expect(bars[0]?.height).toBe(18);
  });

  test('a series of nothing draws nothing rather than a full-height row', () => {
    for (const bar of barLayout([0, 0, 0], 300, 72)) expect(bar.height).toBe(0);
    expect(barPath({ x: 0, y: 72, width: 10, height: 0 })).toBe('');
  });

  test('the path is rounded at the data end and square at the baseline', () => {
    const d = barPath({ x: 0, y: 32, width: 12, height: 40 });
    expect(d.startsWith('M0 72')).toBe(true);
    expect(d).toContain('Q0 32 4 32');
    expect(d.endsWith('L12 72 Z')).toBe(true);
  });

  test('a bar shorter than the corner radius still draws', () => {
    expect(barPath({ x: 0, y: 70, width: 12, height: 2 })).toContain('Q');
  });

  test('the peak is the first of the tallest bars', () => {
    expect(peakIndex([1, 9, 9, 2])).toBe(1);
    expect(peakIndex([])).toBe(0);
  });
});

describe('the words on the page', () => {
  test('tokens read as K, M and B', () => {
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(34_500)).toBe('34.5K');
    expect(formatTokens(3_219_862_108)).toBe('3.2B');
  });

  test('durations read as seconds, minutes then hours', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(121_000)).toBe('2m 1s');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
  });

  test('a day is labelled by month and date', () => {
    expect(dayLabel('2026-08-14')).toBe('Aug 14');
    expect(dayLabel('2026-01-02')).toBe('Jan 2');
  });
});

describe('reading the wire', () => {
  test('a row from the daemon becomes a run', () => {
    expect(
      toRuns([
        {
          agent_id: 2,
          id: 'a6494ae6dcf34b8de',
          type: 'worker',
          label: 'Rebase the open PRs',
          state: 'running',
          started_at: '2026-08-14T04:35:48.000Z',
          ended_at: null,
          turns: 7,
          input_tokens: 12,
          output_tokens: 4200,
          cache_read_tokens: 910_000,
          cache_write_tokens: 24_000,
        },
      ]),
    ).toEqual([
      {
        agentId: 2,
        id: 'a6494ae6dcf34b8de',
        type: 'worker',
        label: 'Rebase the open PRs',
        state: 'running',
        startedAt: Date.parse('2026-08-14T04:35:48.000Z'),
        endedAt: null,
        turns: 7,
        inputTokens: 12,
        outputTokens: 4200,
        cacheReadTokens: 910_000,
        cacheWriteTokens: 24_000,
      },
    ]);
  });

  test('a row with no id or no start is dropped, not charted as zero', () => {
    expect(toRuns([{ id: 'a1' }, { started_at: 'nope' }, 'junk', null])).toEqual([]);
  });

  test('an unknown state is read as lost rather than trusted through', () => {
    const [only] = toRuns([
      { id: 'a1', started_at: '2026-08-14T04:00:00.000Z', state: 'whatever' },
    ]);
    expect(only?.state).toBe('lost');
    expect(only?.turns).toBe(0);
  });
});
