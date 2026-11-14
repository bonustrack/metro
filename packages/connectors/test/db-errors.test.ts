import { describe, expect, test } from 'bun:test';
import { failureText, isNotMigrated, isUndefinedTable, isUniqueViolation } from '../src/db/errors.ts';

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

  test('a missing column counts as not migrated too', () => {
    expect(isNotMigrated(Object.assign(new Error('Failed query: insert'), { cause: { code: '42703' } }))).toBe(true);
    expect(isNotMigrated({ code: '42P01' })).toBe(true);
    expect(isNotMigrated({ code: '23505' })).toBe(false);
  });
});

describe('what a failed query may say in a log', () => {
  test('the driver\'s code and message, never the statement or its parameters', () => {
    const failed = Object.assign(new Error('Failed query: update "connector_subscriptions" set "cursor" = $1\nparams: CURSOR-history-123,v1.SEALEDBODY'), { cause: { code: '57014', message: 'canceling statement due to statement timeout' } });
    expect(failureText(failed)).toBe('57014: canceling statement due to statement timeout');
    expect(failureText(new Error('Failed query: select 1\nparams: SECRET'))).toBe('a database query failed');
    expect(failureText(new Error('socket hang up'))).toBe('socket hang up');
    expect(failureText(Object.assign(new Error('x'), { cause: { code: '22001', message: 'y'.repeat(900) } })).length).toBeLessThan(220);
  });
});
