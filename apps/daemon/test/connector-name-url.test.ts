import { describe, expect, test } from 'bun:test';
import { connectorName } from '@metro-labs/http/connector-input';

describe('a connector name is a label, not an identifier', () => {
  test('spaces, punctuation and unicode all survive', () => {
    for (const name of ['My MySQL server', 'Snapshot · prod', 'café ☕', 'a/b (v2)'])
      expect(connectorName(name)).toBe(name);
  });

  test('it is trimmed, so stray whitespace never becomes part of the key', () => {
    expect(connectorName('  linear  ')).toBe('linear');
  });

  test('a name that is only whitespace is no name at all', () => {
    expect(() => connectorName('   ')).toThrow('a connector needs a name');
    expect(() => connectorName('')).toThrow('a connector needs a name');
    expect(() => connectorName(undefined)).toThrow('a connector needs a name');
  });

  test('control characters stay out, since the name is a json key', () => {
    expect(() => connectorName('two\nlines')).toThrow('control characters');
    expect(() => connectorName('bell\u0007')).toThrow('control characters');
  });

  test('it is capped, so a row cannot carry an essay', () => {
    expect(connectorName('a'.repeat(64))).toHaveLength(64);
    expect(() => connectorName('a'.repeat(65))).toThrow('64 characters or fewer');
  });
});
