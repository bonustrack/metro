import { describe, expect, test } from 'bun:test';
import { activityLabel, agoWords, durationWords, outcomeWords, timingWords } from '../src/lib/activity-words.ts';

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
    expect(outcomeWords('constructor')).toEqual({ word: 'Ended', dot: null });
  });

  test('a received event has its own words, never a dot, and only an expired one is quiet', () => {
    expect(outcomeWords('delivered', 'event')).toEqual({ word: 'Delivered', dot: null });
    expect(outcomeWords('dropped_sender', 'event').word).toBe('Dropped: not on the list');
    expect(outcomeWords('dropped_unverified', 'event').word).toBe('Dropped: sender not verified');
    expect(outcomeWords('dropped_paused', 'event').word).toBe('Dropped: messages paused');
    expect(outcomeWords('dropped_unassigned', 'event').word).toBe('Dropped: connector removed');
    expect(outcomeWords('expired', 'event')).toEqual({ word: 'Expired', dot: null, quiet: true });
    expect(outcomeWords('skipped', 'event').word).toBe('Events skipped');
    for (const outcome of ['delivered', 'dropped_sender', 'dropped_unverified', 'dropped_paused', 'dropped_unassigned', 'expired', 'skipped', 'something_new', 'ok', 'blocked']) {
      expect(outcomeWords(outcome, 'event').dot).toBeNull();
      expect(outcomeWords(outcome, 'event').word).not.toContain('_');
    }
    expect(outcomeWords('something_new', 'event')).toEqual({ word: 'Received', dot: null });
    expect(outcomeWords('delivered')).toEqual({ word: 'Ended', dot: null });
    expect(outcomeWords('blocked', 'call').dot).toBe('danger');
  });

  test('a row names a tool or an event in words, and an event shows no duration', () => {
    expect(activityLabel({ kind: 'call', tool: 'create_issue' })).toBe('Create issue');
    expect(activityLabel({ kind: 'call', tool: 'send' })).toBe('Send messages');
    expect(activityLabel({ kind: 'event', tool: 'item.created' })).toBe('Item created');
    expect(activityLabel({ kind: 'event', tool: 'team/item:status_changed' })).toBe('Team item status changed');
    expect(activityLabel({ kind: 'event', tool: 'send' })).toBe('Send');
    expect(timingWords({ kind: 'call', ms: 1_234 }, '5 min ago')).toBe('1.2 s · 5 min ago');
    expect(timingWords({ kind: 'event', ms: 0 }, '5 min ago')).toBe('5 min ago');
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
