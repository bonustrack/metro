import { describe, expect, test } from 'bun:test';
import { sizeLabel, whenLabel } from '../src/api/when';

describe('human labels', () => {
  test('relative time', () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    expect(whenLabel('2026-09-04T11:59:50Z', now)).toBe('just now');
    expect(whenLabel('2026-09-04T11:30:00Z', now)).toBe('30 min ago');
    expect(whenLabel('2026-09-04T09:00:00Z', now)).toBe('3 h ago');
    expect(whenLabel('2026-09-01T12:00:00Z', now)).toBe('3 d ago');
    expect(whenLabel('garbage', now)).toBe('garbage');
  });

  test('sizes', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(30 * 1024)).toBe('30 KB');
    expect(sizeLabel(29.4 * 1024 * 1024)).toBe('29.4 MB');
  });
});
