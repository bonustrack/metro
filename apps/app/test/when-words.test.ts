import { describe, expect, test } from 'bun:test';
import { timeOf, untilLabel } from '../src/lib/when-words.ts';
import { FRESHNESS_WORD, entrySender, entryText, entryTime, statusWord } from '../src/components/run/words.ts';
import type { RunEntry } from '../src/components/run/model.ts';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const at = (ms: number): string => new Date(NOW + ms).toISOString();

describe('times in words', () => {
  test('a time ahead says how long until it', () => {
    expect(untilLabel(at(20_000), NOW)).toBe('in under a minute');
    expect(untilLabel(at(25 * 60_000), NOW)).toBe('in 25 min');
    expect(untilLabel(at(3 * 3_600_000), NOW)).toBe('in 3 h');
    expect(untilLabel(at(2 * 86_400_000), NOW)).toBe('in 2 d');
  });

  test('a time behind says how long ago, and a bad value stays as it is', () => {
    expect(untilLabel(at(-5 * 60_000), NOW)).toBe('5 min ago');
    expect(untilLabel('soon', NOW)).toBe('soon');
  });

  test('technical details show the exact time instead', () => {
    expect(timeOf(at(3 * 3_600_000), false, NOW)).toBe('in 3 h');
    expect(timeOf(at(-2 * 3_600_000), false, NOW)).toBe('2 h ago');
    expect(timeOf(at(0), true, NOW)).toBe(new Date(NOW).toLocaleString());
  });
});

describe('the Run page in plain words', () => {
  test('statuses and freshness read as words unless technical details are on', () => {
    expect(statusWord('Observed', false)).toBe('Seen');
    expect(statusWord('Completed', false)).toBe('Done');
    expect(statusWord('Observed', true)).toBe('Observed');
    expect(statusWord('Sent', false)).toBe('Sent');
    expect(FRESHNESS_WORD.Fresh).toBe('Live');
    expect(FRESHNESS_WORD.Stale).toBe('Not updated lately');
  });

  test('event times are relative, or the UTC clock with technical details', () => {
    expect(entryTime(NOW - 3 * 60_000, false, NOW)).toBe('3 min ago');
    expect(entryTime(Date.parse('2026-10-17T09:14:07Z'), true, NOW)).toBe('09:14:07');
  });

  test('agent events name who did it and leave raw tool names to technical details', () => {
    const entry: RunEntry = {
      id: 'sdk-1', at: NOW, kind: 'Approval', title: 'Approval waiting', text: 'Approval waiting · mcp__metro__send', sender: 'worker', senderId: 'task-1', station: 'Agent SDK',
      account: '', channel: '', line: '', direction: 'system', status: 'Observed', worker: 'task-1', session: 's1', truncated: false, metadata: [],
    };
    expect(entrySender(entry, false)).toBe('A helper');
    expect(entryText(entry, false)).toBe('Approval waiting');
    expect(entryText(entry, true)).toBe('Approval waiting · mcp__metro__send');
    expect(entrySender({ ...entry, worker: 'Main' }, false)).toBe('Main thread');
    const message: RunEntry = { ...entry, station: 'telegram-bot', sender: 'Silvan', text: 'Hi · there' };
    expect([entrySender(message, false), entryText(message, false)]).toEqual(['Silvan', 'Hi · there']);
  });
});
