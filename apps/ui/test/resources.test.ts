import { describe, expect, test } from 'bun:test';
import { bytesOfLabel, nearest, percentLabel, segments, toResources } from '../src/api/resources.js';

const GB = 1024 * 1024 * 1024;

describe('the usage charts on the Server page', () => {
  test('a daemon answer is read in time order, bad samples are dropped, an older daemon has none', () => {
    const sample = { at: 2, cpu: 5, memUsed: 1, memTotal: 2, diskUsed: 3, diskTotal: 4 };
    const read = toResources({ hostname: 'emma', resources: { stepMs: 60_000, samples: [sample, { ...sample, at: 1 }, { ...sample, cpu: 'x' }] } });
    expect(read?.samples.map((s) => s.at)).toEqual([1, 2]);
    expect(read?.stepMs).toBe(60_000);
    expect(toResources({ hostname: 'an older daemon' })).toBeNull();
    expect(() => toResources(null)).toThrow('unexpected');
  });

  test('a gap longer than two steps breaks the line', () => {
    const points = [0, 1, 2, 6, 7].map((m) => ({ at: m * 60_000, value: m }));
    expect(segments(points, 60_000).map((s) => s.length)).toEqual([3, 2]);
    expect(nearest(points, 5 * 60_000)?.value).toBe(6);
  });

  test('values read as a percent and as used of total', () => {
    expect(percentLabel(12.6)).toBe('13%');
    expect(bytesOfLabel(4 * GB, 16 * GB)).toBe('4.0 of 16.0 GB (25%)');
  });
});
