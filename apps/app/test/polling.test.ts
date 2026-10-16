import { describe, expect, test } from 'bun:test';
import { approvalOf, type Approval } from '@metro-labs/client/api/approvals';
import { waitingCount } from '../src/lib/agent-status.ts';
import { pollDelay } from '../src/lib/shared-poll.ts';

const EVERY = 30_000;

const approval = (id: string): Approval => {
  const parsed = approvalOf({ id, tool: 'mcp__metro__send', preview: '{"line":"metro://telegram-bot/t1/1","text":"Hi"}', line: '' });
  if (parsed === null) throw new Error('not an approval');
  return parsed;
};

describe('one poll per box', () => {
  test('a read that worked polls again at the normal pace', () => {
    expect(pollDelay(undefined, EVERY)).toBe(EVERY);
    expect(pollDelay({ error: null, dataUpdatedAt: 1, errorUpdatedAt: 0, errorUpdateCount: 3 }, EVERY)).toBe(EVERY);
  });

  test('after a failure it keeps polling and waits longer each time, up to five minutes', () => {
    const since = (ms: number): number => pollDelay({ error: new Error('down'), dataUpdatedAt: 1_000, errorUpdatedAt: 1_000 + ms, errorUpdateCount: 9 }, EVERY);
    expect([since(EVERY), since(2 * EVERY), since(4 * EVERY), since(60 * 60_000)]).toEqual([EVERY, 2 * EVERY, 4 * EVERY, 5 * 60_000]);
    const never = (count: number): number => pollDelay({ error: new Error('down'), dataUpdatedAt: 0, errorUpdatedAt: 5, errorUpdateCount: count }, EVERY);
    expect([never(1), never(2), never(3), never(20)]).toEqual([EVERY, 2 * EVERY, 4 * EVERY, 5 * 60_000]);
  });

  test('a count shows only from a read that worked on a box that is online', () => {
    const two = { data: [approval('aaaaa'), approval('bbbbb')], error: null };
    expect(waitingCount(two, true)).toBe(2);
    expect(waitingCount({ data: [], error: null }, true)).toBe(0);
    expect(waitingCount(two, false)).toBeNull();
    expect(waitingCount({ data: two.data, error: new Error('down') }, true)).toBeNull();
    expect(waitingCount({ data: undefined, error: null }, true)).toBeNull();
    expect(waitingCount(undefined, true)).toBeNull();
  });
});
