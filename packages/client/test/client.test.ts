import { afterAll, beforeAll } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { installTestAccount } from './account-fixture.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { fetchSession, fetchStations, StoppedError, type AgentSummary } from '../src/api/client.js';

beforeAll(() => {
  installTestAccount();
});

afterAll(() => {
  clearAccount();
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

describe('the page names no project any more', () => {
  test('the agents list carries no project=', async () => {
    await dashboard([]);
    expect(calls[0]?.url).not.toContain('project=');
  });
});

describe('the agent on the wire', () => {
  test('the page never keeps an agent key, even when an old daemon sends one', async () => {
    const agent = await dashboard([{ id: 'id000000001', name: 'ada-bot', owned: true, key: 'mk_fake' }]);
    expect(agent).toEqual({ id: 'id000000001', name: 'ada-bot' });
  });

  test('a malformed or missing agent never throws', async () => {
    expect(await dashboard([{ id: 7, key: 9 }, null, 7])).toEqual({ id: '', name: '' });
    expect(await dashboard([null])).toBeUndefined();
    expect(await dashboard('nope')).toBeUndefined();
  });
});

describe('daemon feature negotiation', () => {
  test('managed Gmail is offered only on an explicit string capability', async () => {
    for (const features of [undefined, null, 'gmail-managed', [true, null, 7]]) {
      serve({ features });
      expect((await fetchStations()).features).toEqual([]);
    }
    serve({ features: ['gmail-managed', 7, 'future-feature'] });
    expect((await fetchStations()).features).toEqual(['gmail-managed', 'future-feature']);
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
