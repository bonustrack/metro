import { describe, expect, test } from 'bun:test';
import { connectorAuthOf, publicIcons, publicTools } from '../src/catalogue.ts';
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

  test('a standard JSON Schema dialect in $schema is kept, any other address there is still withheld', () => {
    const dialects = ['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema'];
    for (const dialect of dialects) {
      const [tool] = publicTools([{ ...TOOL, inputSchema: { $schema: dialect, type: 'object', properties: { q: { type: 'string', $schema: dialect } } } }], SECRET);
      expect(tool?.inputSchema).toEqual({ $schema: dialect, type: 'object', properties: { q: { type: 'string', $schema: dialect } } });
    }
    const odd = ['https://vendor.example.com/v1/PATH_SECRET/mcp', 'https://json-schema.org/draft/2020-12/schema?k=QUERY_SECRET', 'https://json-schema.org.evil.example/draft-07/schema'];
    for (const value of odd) {
      const [tool] = publicTools([{ ...TOOL, inputSchema: { $schema: value, type: 'object' } }], SECRET);
      expect(JSON.stringify(tool)).not.toMatch(/SECRET|evil/);
    }
    const [named] = publicTools([{ ...TOOL, inputSchema: { type: 'object', properties: { link: { type: 'string', default: 'https://json-schema.org/draft/2020-12/schema' } } } }], SECRET);
    expect(JSON.stringify(named)).toContain('[address withheld]');
  });

  test('a tool name carrying a credential fails the whole list', () => {
    expect(() => publicTools([{ ...TOOL, name: 'PATH_SECRET_tool' }], SECRET)).toThrow();
  });

  test('the vendor credential becomes the request header', () => {
    expect(connectorAuthOf(SECRET)).toEqual({ kind: 'header', name: 'Authorization', value: 'Bearer HEADER_SECRET' });
    expect(connectorAuthOf({ kind: 'none', targetUrl: 'https://vendor.example.com/mcp' })).toEqual({ kind: 'none' });
  });
});

describe('the icons a server declares', () => {
  const icon = (src: string) => ({ src, mimeType: 'image/png' });

  test('an icon on the connector\'s own host is kept, even when the server sits at the root', () => {
    const root: ConnectorSecret = { kind: 'header', targetUrl: 'https://mcp.epost.example.com/', name: 'Authorization', value: 'Bearer HEADER_SECRET' };
    expect(publicIcons([icon('https://mcp.epost.example.com/icon.png')], root)).toEqual([icon('https://mcp.epost.example.com/icon.png')]);
    expect(publicIcons([icon('https://mcp.epost.example.com/icon.png')], { ...root, targetUrl: 'https://mcp.epost.example.com' })).toHaveLength(1);
  });

  test('an icon carrying a query value, a path segment, a header value or a token is dropped', () => {
    for (const src of ['https://cdn.example.com/i.png?k=QUERY_SECRET', 'https://cdn.example.com/PATH_SECRET/i.png', 'https://cdn.example.com/HEADER_SECRET.png'])
      expect(publicIcons([icon(src)], SECRET)).toEqual([]);
    expect(publicIcons([icon('https://vendor.example.com/icon.png')], SECRET)).toHaveLength(1);
  });
});
