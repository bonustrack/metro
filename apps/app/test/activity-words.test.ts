import { describe, expect, test } from 'bun:test';
import { agoWords, callTitle, durationWords, outcomeWords } from '../src/lib/activity-words.ts';

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

  test('a received mail has its own title and words, and a dropped one has no red dot', () => {
    expect(callTitle({ kind: 'received', tool: 'email.received' })).toBe('Received an email');
    expect(callTitle({ kind: 'call', tool: 'send' })).toBe('Send messages');
    expect(outcomeWords('delivered')).toEqual({ word: 'Delivered', dot: null });
    expect(outcomeWords('dropped_sender').word).toBe('Dropped: not in People');
    expect(outcomeWords('dropped_unverified').word).toBe('Dropped: sender not verified');
    expect(outcomeWords('dropped_off').word).toBe('Dropped: Receive messages is off');
    expect(outcomeWords('dropped_paused').word).toBe('Dropped: messages paused');
    expect(outcomeWords('expired')).toEqual({ word: 'Expired', dot: null, quiet: true });
    for (const dropped of ['delivered', 'dropped_sender', 'dropped_unverified', 'dropped_off', 'dropped_paused', 'expired']) expect(outcomeWords(dropped).dot).toBeNull();
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
