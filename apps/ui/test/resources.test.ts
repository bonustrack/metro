import { describe, expect, test } from 'bun:test';
import { creditsLabel, healthOf, nearest, percentLabel, segments, toUsage, type UsageCharts } from '../src/api/resources.js';

const MIN = 60_000;
const TO = 1_790_000_000_000;

const charts = (over: Partial<UsageCharts> = {}): UsageCharts => ({
  available: true,
  region: 'us-east-1',
  from: TO - 60 * MIN,
  to: TO,
  cpu: { stepMs: 5 * MIN, points: [{ at: TO - 10 * MIN, value: 4 }] },
  credits: { stepMs: 5 * MIN, points: [] },
  status: { stepMs: 5 * MIN, points: [{ at: TO - 10 * MIN, value: 0 }] },
  memory: { stepMs: MIN, points: [] },
  disk: { stepMs: MIN, points: [] },
  note: null,
  ...over,
});

describe('the usage charts on the Server page', () => {
  test('an api answer is read in time order, bad points are dropped, a server without charts says why', () => {
    const read = toUsage({
      available: true,
      region: 'eu-central-2',
      from: 1,
      to: 2,
      cpu: { stepMs: 300_000, points: [{ at: 2, value: 5 }, { at: 1, value: 3 }, { at: 3, value: 'x' }] },
      memory: 'nonsense',
      note: 'Update Metro on this server.',
    });
    expect(read.available && read.cpu).toEqual({ stepMs: 300_000, points: [{ at: 1, value: 3 }, { at: 2, value: 5 }] });
    expect(read.available && read.memory).toEqual({ stepMs: 60_000, points: [] });
    expect(read.available && read.note).toBe('Update Metro on this server.');
    expect(toUsage({ available: false, reason: 'A server hosted elsewhere, such as on DigitalOcean, has no charts.' })).toEqual({
      available: false,
      reason: 'A server hosted elsewhere, such as on DigitalOcean, has no charts.',
    });
    expect(() => toUsage(null)).toThrow('unexpected');
  });

  test('a gap longer than two steps breaks the line', () => {
    const points = [0, 1, 2, 6, 7].map((m) => ({ at: m * MIN, value: m }));
    expect(segments(points, MIN).map((s) => s.length)).toEqual([3, 2]);
    expect(nearest(points, 5 * MIN)?.value).toBe(6);
  });

  test('values read as a percent and as credits', () => {
    expect(percentLabel(12.6)).toBe('13%');
    expect(creditsLabel(575.6)).toBe('576 credits');
  });

  test('the health line tells running, stopped, failing and recovered apart', () => {
    expect(healthOf(charts(), '1h')).toEqual({ text: 'Running. AWS status checks pass.', danger: false });
    expect(healthOf(charts({ cpu: { stepMs: 5 * MIN, points: [] } }), '1h').danger).toBe(true);
    expect(healthOf(charts({ cpu: { stepMs: 5 * MIN, points: [{ at: TO - 50 * MIN, value: 1 }] } }), '1h').text).toContain('The server may be stopped.');
    const failing = [20, 15, 10].map((m, i) => ({ at: TO - m * MIN, value: i === 0 ? 0 : 1 }));
    expect(healthOf(charts({ status: { stepMs: 5 * MIN, points: failing } }), '1h')).toMatchObject({ danger: true, text: expect.stringContaining('failing since') as unknown as string });
    const recovered = [20, 15, 10].map((m, i) => ({ at: TO - m * MIN, value: i === 1 ? 1 : 0 }));
    expect(healthOf(charts({ status: { stepMs: 5 * MIN, points: recovered } }), '1h')).toMatchObject({ danger: false, text: expect.stringContaining('failed once in this range') as unknown as string });
  });
});
