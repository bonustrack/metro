import { describe, expect, test } from 'bun:test';
import { isUniqueViolation } from '../src/db/users.js';

class WrappedQueryError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

describe('recognising a duplicate row', () => {
  test('a bare driver error carries the code itself', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  test('the drizzle wrapper puts the driver error in cause, and that still counts', () => {
    const wrapped = new WrappedQueryError('Failed query: insert into …', {
      code: '23505',
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(new WrappedQueryError('outer', wrapped))).toBe(true);
  });

  test('any other code, a bare string, null and a missing cause are not duplicates', () => {
    expect(isUniqueViolation({ code: '42P01' })).toBe(false);
    expect(isUniqueViolation(new WrappedQueryError('x', { code: '23503' }))).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
  });

  test('a cyclic cause chain terminates', () => {
    const loop: { cause?: unknown; code?: string } = {};
    loop.cause = loop;
    expect(isUniqueViolation(loop)).toBe(false);
  });
});
