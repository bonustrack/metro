import { describe, expect, test } from 'bun:test';
import { filled, isRecord, recordOf, str } from '../src/api/read.js';

describe('reading an answer', () => {
  test('isRecord takes a plain object only', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  test('recordOf falls back to an empty object', () => {
    expect(recordOf({ a: 1 })).toEqual({ a: 1 });
    expect(recordOf([1])).toEqual({});
    expect(recordOf(undefined)).toEqual({});
  });

  test('filled is a non-empty string or null', () => {
    expect(filled('a')).toBe('a');
    expect(filled('')).toBeNull();
    expect(filled(3)).toBeNull();
  });

  test('str is a string or empty, never trimmed', () => {
    expect(str(' a ')).toBe(' a ');
    expect(str('')).toBe('');
    expect(str(null)).toBe('');
  });
});
