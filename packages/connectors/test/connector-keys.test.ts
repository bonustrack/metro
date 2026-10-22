import { describe, expect, test } from 'bun:test';
import { splitMcpTool } from '@metro-labs/http/mcp-server-protocol';
import { connectorKeys, slugOf } from '../src/connector-keys.ts';

describe('connector keys', () => {
  test('a key is the slug of the connector name', () => {
    expect(slugOf('Notion')).toBe('notion');
    expect(slugOf('n8n Anderra')).toBe('n8n-anderra');
    expect(slugOf('  Café / Ünïcode!! ')).toBe('cafe-unicode');
    expect(slugOf('***')).toBe('connector');
    expect(slugOf('x'.repeat(100))).toHaveLength(63);
  });

  test('two connectors with the same slug: the older id keeps it, the next gets -2, in id order', () => {
    const keys = connectorKeys([{ id: 'conn0000003', name: 'Notion' }, { id: 'conn0000001', name: 'notion' }, { id: 'conn0000002', name: 'NOTION!' }]);
    expect(Object.fromEntries(keys)).toEqual({ conn0000001: 'notion', conn0000002: 'notion-2', conn0000003: 'notion-3' });
  });

  test('a suffix never takes another connector\'s own slug', () => {
    const keys = connectorKeys([{ id: 'a', name: 'Notion' }, { id: 'b', name: 'Notion' }, { id: 'c', name: 'Notion 2' }]);
    expect(Object.fromEntries(keys)).toEqual({ a: 'notion', b: 'notion-3', c: 'notion-2' });
  });

  test('keys are stable for the same assignments, whatever the input order', () => {
    const rows = [{ id: 'conn0000002', name: 'Linear' }, { id: 'conn0000001', name: 'Linear' }, { id: 'conn0000009', name: 'Slack' }];
    expect(connectorKeys(rows)).toEqual(connectorKeys([...rows].reverse()));
  });

  test('every key makes a valid <connector>.<tool> name, even a long one with a suffix', () => {
    const long = 'a'.repeat(70);
    for (const key of connectorKeys([{ id: '1', name: long }, { id: '2', name: long }]).values()) expect(splitMcpTool(`${key}.search`)).toEqual({ connector: key, tool: 'search' });
  });
});
