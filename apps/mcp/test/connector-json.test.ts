import { describe, expect, test } from 'bun:test';
import { NAME_PREFIX, relayServersJson } from '../src/daemon/connector-json.ts';

const BASE = 'https://mcp.metro.box';
const TOKEN = 'cli-token-abc';

const parsed = (json: string): Record<string, unknown> =>
  (JSON.parse(json) as { mcpServers: Record<string, unknown> }).mcpServers;

describe('the exported block names relays, never vendors', () => {
  test('each entry is the relay url with the caller token as its only header', () => {
    const servers = parsed(
      relayServersJson(
        [{ id: 'conn0000001', name: 'linear' }],
        BASE,
        TOKEN,
      ),
    );
    expect(servers['metro.box linear']).toEqual({
      type: 'http',
      url: `${BASE}/relay/conn0000001`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  test('the metro.box prefix marks every key', () => {
    const servers = parsed(
      relayServersJson(
        [
          { id: 'conn0000001', name: 'linear' },
          { id: 'conn0000002', name: 'notion' },
        ],
        BASE,
        TOKEN,
      ),
    );
    for (const key of Object.keys(servers)) expect(key.startsWith(NAME_PREFIX)).toBe(true);
    expect(Object.keys(servers)).toEqual(['metro.box linear', 'metro.box notion']);
  });

  test('no vendor url or credential can appear, by construction', () => {
    const json = relayServersJson(
      [{ id: 'conn0000003', name: 'internal' }],
      BASE,
      TOKEN,
    );
    expect(json).not.toContain('linear.app');
    expect(json).not.toContain('secret');
  });

  test('an agent with no connectors exports an empty block', () => {
    expect(parsed(relayServersJson([], BASE, TOKEN))).toEqual({});
  });
});
