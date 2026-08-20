import { describe, expect, test } from 'bun:test';
import { carryForward, type AccountGroup } from '../src/api/accounts';

const row = (id: string) => ({ id, agentId: 1, fields: [] });

const PREV: AccountGroup[] = [
  { station: 'xmtp', rows: [row('x0'), row('x1'), row('tony')] },
  { station: 'telegram', rows: [row('t0')] },
];

describe('a station that could not be reached keeps its last known cards', () => {
  test('an unavailable station is carried forward, minus what was just deleted', () => {
    const fresh: AccountGroup[] = [{ station: 'telegram', rows: [row('t0')] }];
    const out = carryForward(fresh, PREV, ['xmtp'], ['xmtp/x0']);
    const xmtp = out.find((g) => g.station === 'xmtp');
    expect(xmtp?.rows.map((r) => r.id)).toEqual(['x1', 'tony']);
    expect(out.find((g) => g.station === 'telegram')?.rows).toHaveLength(1);
  });

  test('a reachable station always wins, even when it is now empty', () => {
    const fresh: AccountGroup[] = [{ station: 'telegram', rows: [] }];
    const out = carryForward(fresh, PREV, [], []);
    expect(out).toBe(fresh);
  });

  test('carrying forward the last row of a station drops the station', () => {
    const out = carryForward([], PREV, ['xmtp', 'telegram'], ['xmtp/x0', 'xmtp/x1', 'xmtp/tony']);
    expect(out.map((g) => g.station)).toEqual(['telegram']);
  });
});
