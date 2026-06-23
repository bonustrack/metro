/**
 * Unit tests for `src/stations/lines.ts` — the `metro://` URI vocabulary.
 *
 * Covers builders (discord/telegram/claude/webhook/user), the generic
 * `parse`/`station` split, the local-session parser (`parseClaude` —
 * participant `/user/<id>` URIs vs full `<userId>/<sessionId>` sessions),
 * `isLocal`, round-trips, and malformed input.
 *
 * Pure in-process; no fs / network.
 */

import { describe, expect, test } from 'bun:test';
import { Line, asLine } from '../src/stations/lines.ts';

describe('Line builders', () => {
  test('discord', () => {
    expect(Line.discord('456')).toBe(asLine('metro://discord/456'));
  });

  test('telegram without topic', () => {
    expect(Line.telegram(123)).toBe(asLine('metro://telegram/123'));
    expect(Line.telegram('-100')).toBe(asLine('metro://telegram/-100'));
  });

  test('telegram with topic', () => {
    expect(Line.telegram(-100, 42)).toBe(asLine('metro://telegram/-100/42'));
    /** topicId === 0 is a real value, must NOT be dropped as undefined. */
    expect(Line.telegram(-100, 0)).toBe(asLine('metro://telegram/-100/0'));
  });

  test('claude full-session builder', () => {
    expect(Line.claude('org1', 'sess1')).toBe(asLine('metro://claude/org1/sess1'));
  });

  test('webhook', () => {
    expect(Line.webhook('gh-main')).toBe(asLine('metro://webhook/gh-main'));
  });

  test('user participant builder', () => {
    expect(Line.user('discord', 'alice')).toBe(asLine('metro://discord/user/alice'));
    expect(Line.user('telegram', 99)).toBe(asLine('metro://telegram/user/99'));
  });
});

describe('Line.parse — generic station/path split', () => {
  test('single-segment path', () => {
    expect(Line.parse('metro://discord/456')).toEqual({ station: 'discord', path: ['456'] });
  });

  test('multi-segment path', () => {
    expect(Line.parse('metro://telegram/-100/42')).toEqual({ station: 'telegram', path: ['-100', '42'] });
  });

  test('collapses empty segments from doubled / and trailing slash', () => {
    expect(Line.parse('metro://discord//456/')).toEqual({ station: 'discord', path: ['456'] });
  });

  test('rejects non-metro prefix', () => {
    expect(Line.parse('https://discord/456')).toBeNull();
    expect(Line.parse('discord/456')).toBeNull();
  });

  test('rejects missing station (no slash after prefix)', () => {
    expect(Line.parse('metro://discord')).toBeNull();
  });

  test('rejects empty station (leading slash)', () => {
    expect(Line.parse('metro:///456')).toBeNull();
  });

  test('rejects station with empty path (only slashes)', () => {
    expect(Line.parse('metro://discord//')).toBeNull();
  });
});

describe('Line.station', () => {
  test('returns station for valid line', () => {
    expect(Line.station('metro://discord/456')).toBe('discord');
  });
  test('returns null for malformed line', () => {
    expect(Line.station('not-a-line')).toBeNull();
  });
});

describe('parseClaude — participant vs full-session URIs', () => {
  test('full session URI parses to {userId, sessionId}', () => {
    expect(Line.parseClaude('metro://claude/org1/sess1')).toEqual({ userId: 'org1', sessionId: 'sess1' });
  });

  test('participant URI (/user/<id>) is skipped — returns null', () => {
    expect(Line.parseClaude('metro://claude/user/abc')).toBeNull();
  });

  test('single-segment (userId only, no session) returns null', () => {
    expect(Line.parseClaude('metro://claude/org1')).toBeNull();
  });

  test('wrong station returns null (claude parser rejects non-claude lines)', () => {
    expect(Line.parseClaude('metro://xmtp/acct1/thread1')).toBeNull();
  });

  test('malformed input returns null', () => {
    expect(Line.parseClaude('garbage')).toBeNull();
  });

  test('extra trailing segments still parse to first two', () => {
    /** path[0]=userId, path[1]=sessionId; anything after is ignored. */
    expect(Line.parseClaude('metro://claude/org1/sess1/extra')).toEqual({ userId: 'org1', sessionId: 'sess1' });
  });
});

describe('isLocal', () => {
  test('claude is local', () => {
    expect(Line.isLocal('metro://claude/org1/sess1')).toBe(true);
  });
  test('discord/telegram/webhook are not local', () => {
    expect(Line.isLocal('metro://discord/456')).toBe(false);
    expect(Line.isLocal('metro://telegram/123')).toBe(false);
    expect(Line.isLocal('metro://webhook/gh-main')).toBe(false);
  });
  test('malformed line is not local', () => {
    expect(Line.isLocal('garbage')).toBe(false);
  });
});

/* xmtp account-scoped lines + round-trips moved to lines-xmtp.test.ts */
