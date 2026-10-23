import { describe, expect, test } from 'bun:test';
import { OTHER_CONNECTORS, type ConnectorStats, type StatsConnector } from '@metro-labs/client/api/connector-stats';
import { connectorName, connectorSlots, emptyCalls, failedAlarm, labelIndices, niceTicks, percentWords, stackSeries, statTiles } from '../src/lib/call-stats.ts';

const COLORS = { slots: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'], other: 'grey', calls: 'blue', failed: 'red' };

const connector = (key: string, total: number, patch: Partial<StatsConnector> = {}): StatsConnector => ({ key, connector: key, name: key.toUpperCase(), url: null, total, failed: 0, ...patch });

const stats = (connectors: StatsConnector[]): ConnectorStats => ({
  range: '7d',
  bucketMs: 21_600_000,
  buckets: [
    { at: 0, total: 6, failed: 2, byConnector: { notion: { total: 4, failed: 2 }, linear: { total: 2, failed: 0 } } },
    { at: 21_600_000, total: 3, failed: 0, byConnector: { notion: { total: 1, failed: 0 }, [OTHER_CONNECTORS]: { total: 2, failed: 0 } } },
  ],
  connectors,
  totals: { total: 9, ok: 6, failed: 2, blocked: 1, denied: 0, waiting: 0, p50Ms: 420, p95Ms: 2_300 },
});

describe('the colour of each connector', () => {
  test('a connector keeps its colour from the organization list, whatever else is shown or filtered out', () => {
    const order = ['linear', 'notion', 'github'];
    const all = connectorSlots([connector('notion', 9), connector('linear', 5), connector('github', 1)], order, 8);
    expect([...all.entries()]).toEqual([['linear', 0], ['notion', 1], ['github', 2]]);
    const filtered = connectorSlots([connector('github', 1)], order, 8);
    expect(filtered.get('github')).toBe(2);
  });

  test('a connector the organization no longer lists comes after the listed ones, and two never share a colour', () => {
    const slots = connectorSlots([connector('gone', 9, { connector: null }), connector('notion', 3)], ['notion'], 8);
    expect([...slots.entries()]).toEqual([['notion', 0], ['gone', 1]]);
    const crowded = connectorSlots([connector('first', 1), connector('ninth', 1)], ['first', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'ninth'], 8);
    expect([...crowded.values()].sort()).toEqual([0, 1]);
    expect(connectorSlots([connector(OTHER_CONNECTORS, 4, { connector: null })], [], 8).size).toBe(0);
  });
});

describe('the stacked series', () => {
  test('all connectors: failed calls at the baseline, the other calls above', () => {
    expect(stackSeries(stats([]), 'all', COLORS, []).map((one) => [one.key, one.color, one.values, one.tip])).toEqual([
      ['failed', 'red', [2, 0], true],
      ['calls', 'blue', [4, 3], false],
    ]);
  });

  test('by connector: one series per connector in colour order, Other last in grey', () => {
    const series = stackSeries(stats([connector('notion', 5, { url: 'https://mcp.notion.com' }), connector('linear', 2), connector(OTHER_CONNECTORS, 2, { connector: null, name: 'Other' })]), 'connector', COLORS, ['linear', 'notion']);
    expect(series.map((one) => [one.key, one.label, one.color, one.values])).toEqual([
      ['linear', 'LINEAR', 's0', [2, 0]],
      ['notion', 'NOTION', 's1', [4, 1]],
      [OTHER_CONNECTORS, 'Other', 'grey', [0, 2]],
    ]);
    expect(series[1]?.url).toBe('https://mcp.notion.com');
  });

  test('a connector with no name shows its key, or Unknown connector', () => {
    expect(connectorName({ name: '', key: 'jira' })).toBe('jira');
    expect(connectorName({ name: '', key: '' })).toBe('Unknown connector');
  });
});

describe('axes', () => {
  test('ticks are round numbers from zero, four steps at most', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(42)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(1_234)).toEqual([0, 500, 1_000, 1_500]);
  });

  test('time labels are spread from the newest bucket back, as many as fit', () => {
    expect(labelIndices('7d', 28, 7)).toEqual([3, 7, 11, 15, 19, 23, 27]);
    expect(labelIndices('7d', 28, 4)).toEqual([3, 11, 19, 27]);
    expect(labelIndices('24h', 24, 6)).toEqual([3, 7, 11, 15, 19, 23]);
    expect(labelIndices('90d', 90, 3)).toEqual([29, 59, 89]);
    expect(labelIndices('30d', 30, 0)).toEqual([14, 29]);
  });
});

describe('the numbers in words', () => {
  test('a share reads in whole percents, with one decimal under 10%', () => {
    expect(percentWords(0, 0)).toBe('0%');
    expect(percentWords(0, 12)).toBe('0%');
    expect(percentWords(1, 3)).toBe('33%');
    expect(percentWords(1, 30)).toBe('3.3%');
    expect(percentWords(5, 100)).toBe('5%');
    expect(percentWords(1, 10_000)).toBe('<0.1%');
  });

  test('the tiles say what each number is', () => {
    expect(statTiles(stats([]).totals, '7d').map((tile) => [tile.label, tile.value, tile.detail, tile.danger])).toEqual([
      ['Calls', '9', 'in the last 7 days', false],
      ['Failed', '22%', '2 calls', true],
      ['Blocked by rules', '11%', '1 call', false],
      ['Waiting for approval', '0', 'asked you first', false],
      ['Typical time', '420 ms', 'half the calls were faster', false],
      ['Slowest 5%', '2.3 s', 'took at least this long', false],
    ]);
    const quiet = statTiles({ total: 4, ok: 0, failed: 0, blocked: 4, denied: 1, waiting: 0, p50Ms: null, p95Ms: null }, '24h');
    expect(quiet.map((tile) => tile.detail)).toEqual(['in the last 24 hours', 'None', '4 calls, 1 denied by you', 'asked you first', 'half the calls were faster', 'took at least this long']);
    expect(quiet[4]?.value).toBe('None');
  });

  test('a failure share is a warning from 5% of the calls', () => {
    expect(failedAlarm(0, 0)).toBe(false);
    expect(failedAlarm(4, 100)).toBe(false);
    expect(failedAlarm(5, 100)).toBe(true);
    expect(statTiles({ total: 100, ok: 96, failed: 4, blocked: 0, denied: 0, waiting: 0, p50Ms: 10, p95Ms: 20 }, '7d')[1]?.danger).toBe(false);
  });

  test('an empty feed says why', () => {
    expect(emptyCalls(null)).toContain('No connector calls yet');
    expect(emptyCalls('notion')).toBe('No calls to this connector yet.');
  });
});
