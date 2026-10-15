import { describe, expect, test } from 'bun:test';
import { olderThan } from '../src/api/version.js';

const FLOOR = '0.1.0-beta.222';

describe('deciding whether a daemon predates a page feature', () => {
  test('prereleases order by number, a release outranks its own prereleases', () => {
    expect(olderThan('0.1.0-beta.221', FLOOR)).toBe(true);
    expect(olderThan('0.1.0-beta.222', FLOOR)).toBe(false);
    expect(olderThan('0.1.0-beta.9', '0.1.0-beta.10')).toBe(true);
    expect(olderThan('0.1.0-beta.230', FLOOR)).toBe(false);
    expect(olderThan('0.1.0', FLOOR)).toBe(false);
    expect(olderThan('0.0.9', FLOOR)).toBe(true);
    expect(olderThan('0.2.0-alpha.1', FLOOR)).toBe(false);
  });

  test('an unknown or unparseable version never hides a feature', () => {
    expect(olderThan(null, FLOOR)).toBe(false);
    expect(olderThan('dev', FLOOR)).toBe(false);
    expect(olderThan('0.1.0-beta.221', 'soon')).toBe(false);
  });
});
