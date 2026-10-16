import { describe, expect, test } from 'bun:test';
import { latestLine, latestParts, toLatestUsage } from '../src/api/latest-usage.js';

describe('the usage readings on the agent list', () => {
  test('an api answer is read per server, and anything that is not a number is missing', () => {
    expect(
      toLatestUsage({
        servers: {
          srv00000001: { cpu: 3.2, memory: 24.4, disk: 61 },
          srv00000002: { cpu: 7, memory: null, disk: 'x' },
          srv00000003: 'nonsense',
        },
      }),
    ).toEqual({
      srv00000001: { cpu: 3.2, memory: 24.4, disk: 61 },
      srv00000002: { cpu: 7, memory: null, disk: null },
    });
    expect(() => toLatestUsage({ error: 'no' })).toThrow('unexpected');
  });

  test('the technical line of the list shows CPU and memory when they are there', () => {
    expect(latestParts({ cpu: 3.2, memory: 24.4, disk: 61 })).toEqual(['CPU 3%', 'Mem 24%']);
    expect(latestParts({ cpu: 7, memory: null, disk: null })).toEqual(['CPU 7%']);
    expect(latestParts({ cpu: null, memory: null, disk: null })).toEqual([]);
    expect(latestParts(undefined)).toEqual([]);
  });

  test('the server line adds the disk, and says when nothing is known', () => {
    expect(latestLine({ cpu: 3.2, memory: 24.4, disk: 61 })).toBe('CPU 3% · Mem 24% · Disk 61%');
    expect(latestLine({ cpu: null, memory: null, disk: null })).toBe('No data');
  });
});
