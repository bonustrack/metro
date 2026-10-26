import { describe, expect, test } from 'bun:test';
import { connectorAuthOf, publicTools } from '../src/catalogue.ts';
import type { ConnectorSecret } from '../src/model.ts';

const SECRET: ConnectorSecret = { kind: 'header', targetUrl: 'https://vendor.example.com/v1/PATH_SECRET/mcp?key=QUERY_SECRET', name: 'Authorization', value: 'Bearer HEADER_SECRET' };

const TOOL = {
  name: 'search',
  title: 'Search',
  description: 'Calls https://vendor.example.com/v1/PATH_SECRET/mcp with HEADER_SECRET',
  readOnly: true,
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'see QUERY_SECRET', enum: ['PATH_SECRET', 'plain'] } } },
};

describe('the public tool list', () => {
  test('the tool list carries a redacted schema', () => {
    const [tool] = publicTools([TOOL], SECRET);
    expect(tool).toEqual({ name: 'search', title: 'Search', description: 'Calls [address withheld] with [redacted]', readOnly: true, inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'see [redacted]', enum: ['[redacted]', 'plain'] } } } });
    expect(JSON.stringify(tool)).not.toMatch(/SECRET/);
  });

  test('a tool name carrying a credential fails the whole list', () => {
    expect(() => publicTools([{ ...TOOL, name: 'PATH_SECRET_tool' }], SECRET)).toThrow();
  });

  test('the vendor credential becomes the request header', () => {
    expect(connectorAuthOf(SECRET)).toEqual({ kind: 'header', name: 'Authorization', value: 'Bearer HEADER_SECRET' });
    expect(connectorAuthOf({ kind: 'none', targetUrl: 'https://vendor.example.com/mcp' })).toEqual({ kind: 'none' });
  });
});
