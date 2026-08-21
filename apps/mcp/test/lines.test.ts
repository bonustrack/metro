/**
 * Unit tests for `src/stations/lines.ts` — the `metro://` URI vocabulary.
 *
 * Covers the builders (claude/webhook/user), the generic `parse`/`station`
 * split, the account-scoped forms, `isLocal`, and malformed input.
 *
 * Pure in-process; no fs / network.
 */

import { describe, expect, test } from 'bun:test';
import { Line, asLine } from '../src/stations/lines.ts';

describe('Line builders', () => {
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

describe('account-scoped xmtp lines', () => {
  test('extra path segments are all preserved', () => {
    expect(Line.parse('metro://xmtp/tony/group/0xdef')).toEqual({
      station: 'xmtp',
      path: ['tony', 'group', '0xdef'],
    });
  });
});
