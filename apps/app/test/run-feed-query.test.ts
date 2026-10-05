import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { RUN_EVENTS_SINCE, type RunEvent, type RunEventsPage } from '@metro-labs/client/api/run-events';
import { clearAccount } from '@metro-labs/client/auth/account';
import { installTestAccount } from '../../../packages/client/test/account-fixture.js';
import { fetchRunFeed } from '../src/components/run/use-run-feed.js';
import { mergeRunFeed, type RetainedRunFeed } from '../src/components/run/metro-entries.js';

const AGENT = 'agent000001';
const KEY = ['run-events', 'http://fixture', AGENT];
const realFetch = globalThis.fetch;
let client: QueryClient;
let calls: URL[];

const events = (start: number, count: number): RunEvent[] => Array.from({ length: count }, (_, index) => ({
  id: `event-${String(start + index)}`, seq: start + index, ts: '2026-10-05T19:00:00.000Z',
  kind: 'msg', direction: 'inbound', agentId: AGENT, station: 'xmtp', accountId: 'account-one',
  line: 'metro://xmtp/account-one/room', text: 'Allowed message', truncated: false, metadata: {},
}));
const page = (rows: RunEvent[], extra: Partial<RunEventsPage> = {}): RunEventsPage => ({
  events: rows, cursor: 'current-cursor', hasMore: false, reset: false,
  retention: { capacity: 500, oldestAt: rows[0]?.ts ?? null, oldestSeq: 101 }, ...extra,
});
const cached = (): RetainedRunFeed | undefined => client.getQueryData<RetainedRunFeed>(KEY);
const poll = (): Promise<RetainedRunFeed> => client.fetchQuery({
  queryKey: KEY, queryFn: () => fetchRunFeed(client, KEY, AGENT, RUN_EVENTS_SINCE), staleTime: 0, retry: false,
});

function serve(answers: (() => Response | Promise<Response>)[]): void {
  globalThis.fetch = Object.assign((input: string | URL | Request): Promise<Response> => {
    calls.push(new URL(String(input)));
    const answer = answers.shift();
    return answer === undefined ? Promise.reject(new Error('Unexpected request')) : Promise.resolve(answer());
  }, { preconnect: realFetch.preconnect });
}

beforeEach(() => {
  installTestAccount();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  calls = [];
});
afterEach(() => {
  client.clear();
  globalThis.fetch = realFetch;
  clearAccount();
});

function seed(): RetainedRunFeed {
  const previous = mergeRunFeed(undefined, page(events(1, 500).map((event) => ({ ...event, text: 'OLD_POLICY_DATA' })), {
    cursor: 'previous-cursor', reset: true, retention: { capacity: 500, oldestAt: '2026-10-05T19:00:00.000Z', oldestSeq: 1 },
  }));
  client.setQueryData(KEY, previous);
  return previous;
}

const query = (index: number): Record<string, string> => Object.fromEntries(calls[index]?.searchParams ?? []);

describe('Run query policy resets', () => {
  test('reboots all 500 retained rows after a 100-row reset and clears the old cache before requesting them', async () => {
    const previous = seed();
    serve([
      () => Response.json(page(events(501, 100), { reset: true })),
      () => {
        expect(cached()?.events).toEqual([]);
        expect(cached()?.cursor).toBe('');
        expect(cached()?.generation).toBeGreaterThan(previous.generation);
        return Response.json(page(events(101, 500), { reset: true }));
      },
    ]);
    const result = await poll();
    expect(query(0)).toEqual({ agent: AGENT, limit: '100', cursor: 'previous-cursor' });
    expect(query(1)).toEqual({ agent: AGENT, limit: '500' });
    expect(result.events).toHaveLength(500);
    expect(result.events[0]?.seq).toBe(101);
    expect(result.events[499]?.seq).toBe(600);
    expect(JSON.stringify(cached())).not.toContain('OLD_POLICY_DATA');
  });

  test('a failed rebootstrap leaves no revoked rows and the next poll retries the full retained window', async () => {
    seed();
    serve([
      () => Response.json(page(events(501, 100), { reset: true })),
      () => Promise.reject(new Error('offline')),
    ]);
    await expect(poll()).rejects.toThrow('Failed to reach Metro.');
    expect(cached()?.events).toEqual([]);
    expect(cached()?.cursor).toBe('');
    expect(JSON.stringify(cached())).not.toContain('OLD_POLICY_DATA');
    serve([() => Response.json(page(events(101, 500), { reset: true }))]);
    expect((await poll()).events).toHaveLength(500);
    expect(query(2)).toEqual({ agent: AGENT, limit: '500' });
  });

  test('a reset arriving after a separate cache purge cannot recreate revoked state', async () => {
    seed();
    serve([() => {
      client.removeQueries({ queryKey: KEY, exact: true });
      return Response.json(page(events(501, 100), { reset: true }));
    }]);
    await expect(fetchRunFeed(client, KEY, AGENT, RUN_EVENTS_SINCE)).rejects.toThrow('Run events changed while loading.');
    expect(cached()).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('byte-limited bootstrap pages still drain forward without discarding retained older rows', async () => {
    seed();
    serve([
      () => Response.json(page(events(501, 100), { reset: true })),
      () => Response.json(page(events(101, 120), { reset: true, hasMore: true, cursor: 'bootstrap-cursor' })),
      () => Response.json(page(events(221, 100), { hasMore: true })),
    ]);
    expect((await poll()).events).toHaveLength(120);
    const next = await poll();
    expect(query(2)).toEqual({ agent: AGENT, limit: '100', cursor: 'bootstrap-cursor' });
    expect(next.events).toHaveLength(220);
    expect(next.events[0]?.seq).toBe(101);
    expect(next.events[219]?.seq).toBe(320);
    expect(next.hasMore).toBe(true);
  });

  test('initial loads and ordinary incremental polls do not add another bootstrap request', async () => {
    serve([
      () => Response.json(page(events(101, 500), { reset: true })),
      () => Response.json(page(events(601, 1))),
    ]);
    expect((await poll()).events).toHaveLength(500);
    const next = await poll();
    expect(calls).toHaveLength(2);
    expect(query(0)).toEqual({ agent: AGENT, limit: '500' });
    expect(query(1)).toEqual({ agent: AGENT, limit: '100', cursor: 'current-cursor' });
    expect(next.events).toHaveLength(500);
    expect(next.events[0]?.seq).toBe(102);
  });
});
