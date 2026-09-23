import { describe, expect, test } from 'bun:test';
import { RESERVED_SEGMENTS, isOrganizationSlug, splitOrganization } from '../src/auth/org-segment.js';
import { routedSegment } from '../src/auth/daemon.js';

describe('reserved segments', () => {
  test('one list covers the global pages and the api words', () => {
    for (const word of ['docs', 'settings', 'connect', 'launch', 'login', 'signup', 'waitlist', 'auth', 'members', 'organization', 'api', 'admin', 'metro', 'new', 'connector', 'connectors'])
      expect(RESERVED_SEGMENTS.has(word)).toBe(true);
  });

  test('a reserved word is never an organization slug nor a box segment', () => {
    for (const word of RESERVED_SEGMENTS) {
      expect(isOrganizationSlug(word)).toBe(false);
      expect(routedSegment(`#/${word}`)).toBeNull();
    }
  });

  test('an agent page word still follows an organization slug', () => {
    expect(splitOrganization('#/stage-labs/tony/server').organization).toBe('stage-labs');
    expect(splitOrganization('#/tony/server').organization).toBeNull();
  });
});
