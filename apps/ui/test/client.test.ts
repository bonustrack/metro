import { beforeAll } from 'bun:test';
import { installTestAccount } from './account-fixture.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { fetchConnectors } from '../src/api/connectors.js';
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

const dashboard = async (agents: unknown): Promise<AgentSummary | undefined> => {
  serve({ agents });
  return (await fetchStations()).agent;
};

describe('a page newer than the daemon', () => {
  test('still names the project a daemon before beta.173 requires, on the agents list and on connectors', async () => {
    await dashboard([]);
    expect(calls[0]?.url).toContain('project=localdaemon');
    serve({ connectors: [] });
    await fetchConnectors();
    expect(calls[0]?.url).toContain('project=localdaemon');
  });
});

describe('the agent on the wire', () => {
  test('the page never keeps an agent key, even when an old daemon sends one', async () => {
    const agent = await dashboard([{ id: 'id000000001', name: 'ada-bot', owned: true, key: 'mk_fake' }]);
    expect(agent).toEqual({ id: 'id000000001', name: 'ada-bot', connectorIds: [] });
  });

  test('a malformed or missing agent never throws', async () => {
    expect(await dashboard([{ id: 7, key: 9 }, null, 7])).toEqual({ id: '', name: '', connectorIds: [] });
    expect(await dashboard([null])).toBeUndefined();
    expect(await dashboard('nope')).toBeUndefined();
  });

  test('connector ids ride on the agent and junk entries are dropped', async () => {
    const agent = await dashboard([{ id: 'id000000001', name: 'ada-bot', connector_ids: ['id000000012', 7, null] }]);
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
