import { describe, expect, test } from 'bun:test';
import { olderThan, parseVersion } from '../src/api/version';

describe('deciding whether a daemon predates a page feature', () => {
  test('prereleases order by number, a release outranks its own prereleases', () => {
    expect(olderThan('0.1.0-beta.66', '0.1.0-beta.67')).toBe(true);
    expect(olderThan('0.1.0-beta.67', '0.1.0-beta.67')).toBe(false);
    expect(olderThan('0.1.0-beta.9', '0.1.0-beta.10')).toBe(true);
    expect(olderThan('0.1.0-beta.70', '0.1.0-beta.67')).toBe(false);
    expect(olderThan('0.1.0', '0.1.0-beta.67')).toBe(false);
    expect(olderThan('0.0.9', '0.1.0-beta.67')).toBe(true);
    expect(olderThan('0.2.0-alpha.1', '0.1.0-beta.67')).toBe(false);
  });

  test('an unknown or unparseable version never hides a feature', () => {
    expect(olderThan(null, '0.1.0-beta.67')).toBe(false);
    expect(olderThan('dev', '0.1.0-beta.67')).toBe(false);
    expect(olderThan('0.1.0-beta.66', 'soon')).toBe(false);
    expect(parseVersion('1.2.3')).toEqual({ release: [1, 2, 3], pre: null });
    expect(parseVersion('v1')).toBeNull();
  });
});
