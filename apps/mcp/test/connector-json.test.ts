import { describe, expect, test } from 'bun:test';
import {
  mcpServersJson,
  type ConnectorEntry,
} from '../src/daemon/connector-json.ts';

const linear: ConnectorEntry = {
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  transport: 'http',
  header: 'Authorization',
  secret: 'Bearer lin_oauth_7f',
  bearer: null,
};

const docs: ConnectorEntry = {
  name: 'docs',
  url: 'https://docs.example.com/mcp',
  transport: 'http',
  header: null,
  secret: null,
  bearer: null,
};

const notion: ConnectorEntry = {
  name: 'notion',
  url: 'https://mcp.notion.com/mcp',
  transport: 'http',
  header: 'X-Api-Key',
  secret: 'ntn_secret_value',
  bearer: null,
};

const signedIn: ConnectorEntry = {
  name: 'snapshot',
  url: 'https://mcp.snapshot.box',
  transport: 'http',
  header: null,
  secret: null,
  bearer: 'oat_live_9c31',
};

interface ServerBlock {
  type: string;
  url: string;
  headers?: Record<string, string>;
}

const parse = (json: string): Record<string, ServerBlock> => {
  const parsed = JSON.parse(json) as { mcpServers: Record<string, ServerBlock> };
  return parsed.mcpServers;
};

describe('mcpServersJson composes the paste-ready block', () => {
  test('an authed connector carries its one header', () => {
    expect(parse(mcpServersJson([linear])).linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer lin_oauth_7f' },
    });
  });

  test('headers is omitted entirely when there is no auth', () => {
    const json = mcpServersJson([docs]);
    const block = parse(json).docs;
    expect(block).toEqual({ type: 'http', url: 'https://docs.example.com/mcp' });
    expect(block !== undefined && 'headers' in block).toBe(false);
    expect(json).not.toContain('headers');
  });

  test('a half-filled auth pair emits no headers rather than a broken one', () => {
    for (const half of [
      { ...docs, header: 'Authorization' },
      { ...docs, secret: 'Bearer lonely' },
    ])
      expect(parse(mcpServersJson([half])).docs).toEqual({
        type: 'http',
        url: 'https://docs.example.com/mcp',
      });
  });

  test('the transport rides through as the block type', () => {
    expect(parse(mcpServersJson([{ ...docs, transport: 'sse' }])).docs?.type).toBe(
      'sse',
    );
  });

  test('every connector merges into one mcpServers object, in order', () => {
    const servers = parse(mcpServersJson([linear, docs, notion]));
    expect(Object.keys(servers)).toEqual(['linear', 'docs', 'notion']);
    expect(servers.notion?.headers).toEqual({ 'X-Api-Key': 'ntn_secret_value' });
    expect(servers.docs?.headers).toBeUndefined();
  });

  test('the name is the object key, so a duplicate silently overwrites', () => {
    const servers = parse(
      mcpServersJson([linear, { ...notion, name: 'linear' }]),
    );
    expect(Object.keys(servers)).toEqual(['linear']);
    expect(servers.linear?.url).toBe('https://mcp.notion.com/mcp');
  });

  test('no connectors is still a valid, pasteable block', () => {
    expect(mcpServersJson([])).toBe('{\n  "mcpServers": {}\n}');
  });

  test('the string is two-space pretty-printed, not minified', () => {
    const json = mcpServersJson([linear]);
    expect(json.startsWith('{\n  "mcpServers": {\n    "linear": {\n')).toBe(true);
    expect(json).toContain('\n      "type": "http"');
  });
});

describe('the paste-ready block carries whatever credential the row holds', () => {
  test('an oauth row exports its access token as a bearer header', () => {
    const servers = parse(mcpServersJson([signedIn]));
    expect(servers.snapshot?.headers).toEqual({
      Authorization: 'Bearer oat_live_9c31',
    });
  });

  test('a stored header still wins, so a row never exports two credentials', () => {
    const both: ConnectorEntry = { ...notion, bearer: 'oat_live_9c31' };
    expect(parse(mcpServersJson([both])).notion?.headers).toEqual({
      'X-Api-Key': 'ntn_secret_value',
    });
  });

  test('an empty bearer is no bearer, never a literal "Bearer "', () => {
    const blank: ConnectorEntry = { ...docs, bearer: '' };
    expect(parse(mcpServersJson([blank])).docs?.headers).toBeUndefined();
  });

  test('the combined block signs in every row it can, in one copy', () => {
    const servers = parse(mcpServersJson([linear, docs, signedIn]));
    expect(servers.linear?.headers).toEqual({
      Authorization: 'Bearer lin_oauth_7f',
    });
    expect(servers.snapshot?.headers).toEqual({
      Authorization: 'Bearer oat_live_9c31',
    });
    expect(servers.docs?.headers).toBeUndefined();
  });
});
