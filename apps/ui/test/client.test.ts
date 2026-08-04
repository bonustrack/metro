import { afterEach, describe, expect, test } from 'bun:test';
import { fetchDashboard, type AgentSummary } from '../src/api/client';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof fetch;
}

const dashboard = async (agents: unknown): Promise<AgentSummary[]> => {
  serve({ email: 'ada@lovelace.dev', endpoint: 'https://mcp.metro.box/mcp', agents });
  return (await fetchDashboard('session')).agents;
};

describe('agent credentials on the wire', () => {
  test('an owned agent carries one key, its endpoint and its command', async () => {
    const [agent] = await dashboard([
      {
        id: 1,
        name: 'ada-bot',
        owned: true,
        key: 'mk_fake',
        endpoint: 'https://mcp.metro.box/mcp?token=mk_fake',
        command: 'claude mcp add x',
      },
    ]);
    expect(agent).toEqual({
      id: 1,
      name: 'ada-bot',
      owned: true,
      key: 'mk_fake',
      endpoint: 'https://mcp.metro.box/mcp?token=mk_fake',
      command: 'claude mcp add x',
    });
  });

  test('a granted agent carries no key, endpoint or command', async () => {
    const [agent] = await dashboard([
      { id: 5, name: 'legacy', owned: false, key: null, endpoint: null, command: null },
    ]);
    expect(agent).toEqual({
      id: 5,
      name: 'legacy',
      owned: false,
      key: null,
      endpoint: null,
      command: null,
    });
  });

  test('a daemon that still sends the old keys array is read from its first entry', async () => {
    const [agent] = await dashboard([
      {
        id: 1,
        name: 'ada-bot',
        owned: true,
        keys: [
          {
            name: 'default',
            key: 'mk_legacy',
            endpoint: 'https://mcp.metro.box/mcp?token=mk_legacy',
            command: 'claude mcp add legacy',
          },
        ],
      },
    ]);
    expect(agent?.key).toBe('mk_legacy');
    expect(agent?.command).toBe('claude mcp add legacy');
    expect(agent?.name).toBe('ada-bot');
  });

  test('an old-daemon agent with an empty keys array reads as no key', async () => {
    const [agent] = await dashboard([
      { id: 1, name: 'ada-bot', owned: true, keys: [] },
    ]);
    expect([agent?.key, agent?.endpoint, agent?.command]).toEqual([null, null, null]);
  });

  test('a malformed agent entry never throws and never invents a key', async () => {
    const agents = await dashboard([{ id: 'nope', keys: 'not-an-array' }, null, 7]);
    expect(agents).toEqual([{ id: 0, name: '', owned: false, key: null, endpoint: null, command: null }]);
  });
});
