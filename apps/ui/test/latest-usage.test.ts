import { describe, expect, test } from 'bun:test';
import { latestLine, toLatestUsage } from '../src/api/latest-usage.js';

describe('the usage line on the agent list and the agent home', () => {
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

  test('the line shows what is there, and No data when nothing is', () => {
    expect(latestLine({ cpu: 3.2, memory: 24.4, disk: 61 })).toBe('CPU 3% · Mem 24% · Disk 61%');
    expect(latestLine({ cpu: 7, memory: null, disk: null })).toBe('CPU 7%');
    expect(latestLine({ cpu: null, memory: null, disk: null })).toBe('No data');
  });
});
