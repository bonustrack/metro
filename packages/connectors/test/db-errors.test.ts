import { describe, expect, test } from 'bun:test';
import { isUndefinedTable, isUniqueViolation } from '../src/db/errors.ts';

describe('spotting a unique violation', () => {
  test('the code is read off the error itself or off the cause Drizzle wraps it in', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('Failed query: update'), { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('x'), { cause: { cause: { code: '23505' } } }))).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  test('a missing table is told apart the same way, so a reader can wait for a migration', () => {
    expect(isUndefinedTable({ code: '42P01' })).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error('Failed query: select'), { cause: { code: '42P01' } }))).toBe(true);
    expect(isUndefinedTable({ code: '23505' })).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
