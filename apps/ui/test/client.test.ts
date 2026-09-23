import { beforeAll } from 'bun:test';
import { installTestAccount } from './account-fixture.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { fetchSession, fetchStations, StoppedError, type AgentSummary } from '../src/api/client.js';

beforeAll(() => {
  installTestAccount();
});

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
  serve({ agents });
  return (await fetchStations()).agents;
};

describe('an agent on the wire', () => {
  test('the page never keeps an agent key, even when an old daemon sends one', async () => {
    const [agent] = await dashboard([{ id: 'id000000001', name: 'ada-bot', owned: true, key: 'mk_fake' }]);
    expect(agent).toEqual({ id: 'id000000001', name: 'ada-bot', owned: true, connectorIds: [] });
  });

  test('a malformed agent entry never throws', async () => {
    const agents = await dashboard([{ id: 7, key: 9 }, null, 7]);
    expect(agents).toEqual([{ id: '', name: '', owned: false, connectorIds: [] }]);
  });
});

describe('what an agent holds', () => {
  test('connector ids ride on the agent and junk entries are dropped', async () => {
    const [agent] = await dashboard([
      { id: 'id000000001', name: 'ada-bot', owned: true, connector_ids: ['id000000012', 7, null] },
    ]);
    expect(agent?.connectorIds).toEqual(['id000000012']);
  });
});

describe('a parked daemon', () => {
  test('answers 503 with stopped, which every page reads as one StoppedError', async () => {
    serve({ error: 'metro is stopped on this machine.', stopped: true }, 503);
    await expect(fetchSession()).rejects.toBeInstanceOf(StoppedError);
    serve({ error: 'busy' }, 503);
    const plain = await fetchSession().catch((err: unknown) => err);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(StoppedError);
  });
});
