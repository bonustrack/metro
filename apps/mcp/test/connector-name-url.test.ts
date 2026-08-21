import { describe, expect, test } from 'bun:test';
import { connectorName } from '../src/db/connector-config.ts';
import {
  connectorUrlText,
  parseConnectorUrl,
} from '../src/daemon/connector-url.ts';

const stored = (raw: string): string => connectorUrlText(parseConnectorUrl(raw));

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

describe('a stored url keeps the shape it was given', () => {
  test('a bare host is not given a trailing slash', () => {
    expect(stored('https://mysql-mcp.snapshot.box')).toBe(
      'https://mysql-mcp.snapshot.box',
    );
  });

  test('a host typed with a trailing slash settles on the same value', () => {
    expect(stored('https://mysql-mcp.snapshot.box/')).toBe(
      'https://mysql-mcp.snapshot.box',
    );
  });

  test('a real path is left exactly alone', () => {
    expect(stored('https://mcp.linear.app/mcp')).toBe('https://mcp.linear.app/mcp');
    expect(stored('https://example.com/mcp/')).toBe('https://example.com/mcp/');
  });

  test('a query survives, slash and all, because stripping it would move the target', () => {
    expect(stored('https://example.com/?tenant=acme')).toBe(
      'https://example.com/?tenant=acme',
    );
  });

  test('what it returns still parses, so a re-check reaches the same host', () => {
    const text = stored('https://mysql-mcp.snapshot.box');
    expect(parseConnectorUrl(text).hostname).toBe('mysql-mcp.snapshot.box');
  });
});
