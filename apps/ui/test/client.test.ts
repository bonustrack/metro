import { afterEach, describe, expect, test } from 'bun:test';
import { fetchAgents, resetAgentKey, type AgentSummary } from '../src/api/client';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  url: string;
  method: string | undefined;
}

let calls: Seen[] = [];

function serve(body: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

const dashboard = async (agents: unknown): Promise<AgentSummary[]> => {
  serve({ email: 'ada@lovelace.dev', endpoint: 'https://mcp.metro.box/mcp', agents });
  return (await fetchAgents('session')).agents;
};

describe('agent credentials on the wire', () => {
  test('an owned agent carries one key, its endpoint and its command', async () => {
    const [agent] = await dashboard([
      {
        id: 'id000000001',
        name: 'ada-bot',
        owned: true,
        key: 'mk_fake',
        endpoint: 'https://mcp.metro.box/mcp?token=mk_fake',
        command: 'claude mcp add x',
      },
    ]);
    expect(agent).toEqual({
      id: 'id000000001',
      name: 'ada-bot',
      owned: true,
      runtime: null,
      connected: false,
      lastSeen: null,
      key: 'mk_fake',
      endpoint: 'https://mcp.metro.box/mcp?token=mk_fake',
      command: 'claude mcp add x',
      connectorIds: [],
    });
  });

  test('a not-owned agent carries no key, endpoint or command', async () => {
    const [agent] = await dashboard([
      { id: 'id000000005', name: 'legacy', owned: false, key: null, endpoint: null, command: null },
    ]);
    expect(agent).toEqual({
      id: 'id000000005',
      name: 'legacy',
      owned: false,
      runtime: null,
      connected: false,
      lastSeen: null,
      key: null,
      endpoint: null,
      command: null,
      connectorIds: [],
    });
  });

  test('a daemon that still sends the old keys array is read from its first entry', async () => {
    const [agent] = await dashboard([
      {
        id: 'id000000001',
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
      { id: 'id000000001', name: 'ada-bot', owned: true, keys: [] },
    ]);
    expect([agent?.key, agent?.endpoint, agent?.command]).toEqual([null, null, null]);
  });

  test('a malformed agent entry never throws and never invents a key', async () => {
    const agents = await dashboard([{ id: 7, keys: 'not-an-array' }, null, 7]);
    expect(agents).toEqual([
      {
        id: '',
        name: '',
        owned: false,
      runtime: null,
        connected: false,
        lastSeen: null,
        key: null,
        endpoint: null,
        command: null,
        connectorIds: [],
      },
    ]);
  });
});

describe('resetAgentKey', () => {
  const ROTATED = {
    id: 'id000000007',
    name: 'tony',
    reset: true,
    key: 'mk_rotated',
    endpoint: 'https://mcp.metro.box/mcp?token=mk_rotated',
    command: 'claude mcp add --transport http metro "x"',
  };

  test('POSTs to the agent key sub-resource', async () => {
    serve(ROTATED);
    await resetAgentKey('session', 7);
    expect(calls).toEqual([
      { url: 'https://mcp.metro.box/api/agents/7/key', method: 'POST' },
    ]);
  });

  test('a refusal is surfaced with the daemon own message', async () => {
    serve({ error: 'no such agent' }, 404);
    await expect(resetAgentKey('session', 8)).rejects.toThrow('no such agent');
  });

  test('a response without a key is rejected rather than shown as empty', async () => {
    serve({ id: 'id000000007', name: 'tony', reset: true });
    await expect(resetAgentKey('session', 7)).rejects.toThrow('unexpected');
  });
});

describe('what an agent holds', () => {
  test('connector ids ride on the agent and junk entries are dropped', async () => {
    const [agent] = await dashboard([
      {
        id: 'id000000001',
        name: 'ada-bot',
        owned: true,
        key: null,
        endpoint: null,
        command: null,
        connector_ids: ['id000000012', 7, null],
      },
    ]);
    expect(agent?.connectorIds).toEqual(['id000000012']);
  });
});
