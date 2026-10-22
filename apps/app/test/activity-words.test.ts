import { describe, expect, test } from 'bun:test';
import { agoWords, durationWords, outcomeWords } from '../src/lib/activity-words.ts';

const NOW = Date.parse('2026-10-22T09:00:00Z');

describe('a connector call in words', () => {
  test('each outcome mcp.metro.box records has a plain word, and only a failure or a block has a dot', () => {
    expect(outcomeWords('ok')).toEqual({ word: 'Done', dot: null });
    expect(outcomeWords('needs_approval')).toEqual({ word: 'Waiting for approval', dot: null });
    for (const failed of ['vendor_error', 'unavailable', 'signin', 'blocked', 'denied', 'not_found', 'invalid']) {
      expect(outcomeWords(failed).dot).toBe('danger');
      expect(outcomeWords(failed).word).not.toContain('_');
    }
    expect(outcomeWords('something_new')).toEqual({ word: 'Ended', dot: null });
  });

  test('a duration reads in ms, seconds or minutes', () => {
    expect(durationWords(42)).toBe('42 ms');
    expect(durationWords(1_234)).toBe('1.2 s');
    expect(durationWords(42_400)).toBe('42 s');
    expect(durationWords(60_000)).toBe('1 min');
    expect(durationWords(125_000)).toBe('2 min 5 s');
  });

  test('a time reads in seconds for the last minute, then like every other time', () => {
    expect(agoWords(NOW - 500, NOW)).toBe('just now');
    expect(agoWords(NOW + 3_000, NOW)).toBe('just now');
    expect(agoWords(NOW - 12_000, NOW)).toBe('12 s ago');
    expect(agoWords(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(agoWords(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
  });
});
