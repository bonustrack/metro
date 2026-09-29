import { describe, expect, test } from 'bun:test';
import { USAGE_SINCE } from '../src/api/usage.js';
import { olderThan } from '../src/api/version.js';

describe('deciding whether a daemon predates a page feature', () => {
  test('prereleases order by number, a release outranks its own prereleases', () => {
    expect(olderThan('0.1.0-beta.221', USAGE_SINCE)).toBe(true);
    expect(olderThan('0.1.0-beta.222', USAGE_SINCE)).toBe(false);
    expect(olderThan('0.1.0-beta.9', '0.1.0-beta.10')).toBe(true);
    expect(olderThan('0.1.0-beta.230', USAGE_SINCE)).toBe(false);
    expect(olderThan('0.1.0', USAGE_SINCE)).toBe(false);
    expect(olderThan('0.0.9', USAGE_SINCE)).toBe(true);
    expect(olderThan('0.2.0-alpha.1', USAGE_SINCE)).toBe(false);
  });

  test('an unknown or unparseable version never hides a feature', () => {
    expect(olderThan(null, USAGE_SINCE)).toBe(false);
    expect(olderThan('dev', USAGE_SINCE)).toBe(false);
    expect(olderThan('0.1.0-beta.221', 'soon')).toBe(false);
  });
});
