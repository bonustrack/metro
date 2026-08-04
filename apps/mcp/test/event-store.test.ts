/**
 * The SSE resumption buffer. Every frame carries the line it was generated for
 * and the scope that owned the stream at the moment it was stored, and
 * `replayEventsAfter` re-checks both against the identity presenting the
 * Last-Event-ID — the same `eventInScope` predicate ChannelRelay.deliver uses.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BoundedEventStore } from '../src/mcp/event-store.ts';
import { setAgentMap } from '../src/db/agent-map.ts';

const STREAM = '_GET_stream';
const TONY = new Set([1]);
const LISA = new Set([34]);
const BOTH = new Set([1, 34]);

const TONY_LINE = 'metro://whatsapp/a1-tony/111@lid';
const LISA_LINE = 'metro://whatsapp/a34-lisa/222@lid';

beforeEach(() =>
  setAgentMap(
    { 'whatsapp/a1-tony': 1, 'whatsapp/a34-lisa': 34 },
    { 1: 'Tony', 34: 'Lisa' },
  ),
);
afterAll(() => setAgentMap({}, {}));

const note = (n: number, line?: string): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: line === undefined ? { n } : { n, meta: { line } },
  }) as unknown as JSONRPCMessage;

const storeFor = (owner: Set<number>, max?: number): BoundedEventStore =>
  new BoundedEventStore(
    max === undefined
      ? { scopeOf: () => owner }
      : { scopeOf: () => owner, max },
  );

const collect = async (
  store: BoundedEventStore,
  lastEventId: string,
  scope: Set<number> | undefined,
): Promise<JSONRPCMessage[]> => {
  const out: JSONRPCMessage[] = [];
  await store.replayEventsAfter(lastEventId, {
    scope,
    send: (_id, message) => {
      out.push(message);
      return Promise.resolve();
    },
  });
  return out;
};

const ns = (msgs: JSONRPCMessage[]): number[] =>
  msgs.map((m) => (m as { params: { n: number } }).params.n);

describe('BoundedEventStore', () => {
  test('replays events stored after Last-Event-ID, in order', async () => {
    const store = storeFor(TONY);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await store.storeEvent(STREAM, note(i, TONY_LINE)));

    expect(ns(await collect(store, ids[1], TONY))).toEqual([2, 3, 4]);
  });

  test('replay is filtered to the same stream', async () => {
    const store = storeFor(TONY);
    const a0 = await store.storeEvent('stream-a', note(0, TONY_LINE));
    await store.storeEvent('stream-b', note(99, TONY_LINE));
    await store.storeEvent('stream-a', note(1, TONY_LINE));

    expect(ns(await collect(store, a0, TONY))).toEqual([1]);
  });

  test('evicts past the cap but still replays what remains', async () => {
    const store = storeFor(TONY, 3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(await store.storeEvent(STREAM, note(i, TONY_LINE)));

    expect(ns(await collect(store, ids[3], TONY))).toEqual([4, 5]);
    expect(await collect(store, ids[0], TONY)).toEqual([]);
  });

  test('event ids are monotonic and map back to their stream', async () => {
    const store = storeFor(TONY);
    const id0 = await store.storeEvent(STREAM, note(0, TONY_LINE));
    const id1 = await store.storeEvent(STREAM, note(1, TONY_LINE));
    expect(id0).not.toEqual(id1);
    expect(await store.getStreamIdForEventId(id1)).toEqual(STREAM);
    const seq0 = Number(id0.slice(id0.lastIndexOf('_') + 1));
    const seq1 = Number(id1.slice(id1.lastIndexOf('_') + 1));
    expect(seq1).toBeGreaterThan(seq0);
  });

  test('a notification stored while no stream is attached is later replayable', async () => {
    const store = storeFor(TONY);
    const baseline = await store.storeEvent(STREAM, note(0, TONY_LINE));
    const duringGap = await store.storeEvent(STREAM, note(42, TONY_LINE));
    expect(await store.getStreamIdForEventId(duringGap)).toEqual(STREAM);

    expect(ns(await collect(store, baseline, TONY))).toEqual([42]);
  });
});

describe('BoundedEventStore replay scope', () => {
  test('a frame for another agent is never replayed, its neighbours still are', async () => {
    const store = storeFor(BOTH);
    const base = await store.storeEvent(STREAM, note(0, TONY_LINE));
    await store.storeEvent(STREAM, note(1, LISA_LINE));
    await store.storeEvent(STREAM, note(2, TONY_LINE));

    expect(ns(await collect(store, base, TONY))).toEqual([2]);
    expect(ns(await collect(store, base, LISA))).toEqual([1]);
  });

  test('the withheld frame is still there for its rightful owner afterwards', async () => {
    const store = storeFor(BOTH);
    const base = await store.storeEvent(STREAM, note(0, TONY_LINE));
    await store.storeEvent(STREAM, note(7, LISA_LINE));

    expect(await collect(store, base, TONY)).toEqual([]);
    expect(ns(await collect(store, base, LISA))).toEqual([7]);
    expect(ns(await collect(store, base, LISA))).toEqual([7]);
  });

  test('an absent scope replays nothing at all', async () => {
    const store = storeFor(TONY);
    const base = await store.storeEvent(STREAM, note(0, TONY_LINE));
    await store.storeEvent(STREAM, note(1, TONY_LINE));

    expect(await collect(store, base, undefined)).toEqual([]);
    expect(await collect(store, base, new Set())).toEqual([]);
  });

  test('a line-less frame goes only to the scope it was stored under', async () => {
    const store = storeFor(LISA);
    const base = await store.storeEvent(STREAM, note(0, LISA_LINE));
    await store.storeEvent(STREAM, note(5));

    expect(await collect(store, base, TONY)).toEqual([]);
    expect(ns(await collect(store, base, LISA))).toEqual([5]);
    expect(ns(await collect(store, base, BOTH))).toEqual([5]);
  });

  test('a line-less frame stored with nobody bound reaches nobody', async () => {
    const store = storeFor(new Set());
    const base = await store.storeEvent(STREAM, note(0));
    await store.storeEvent(STREAM, note(1));

    expect(await collect(store, base, TONY)).toEqual([]);
    expect(await collect(store, base, BOTH)).toEqual([]);
  });

  test('a frame on an account that lost its agent mapping is withheld', async () => {
    const store = storeFor(TONY);
    const base = await store.storeEvent(STREAM, note(0, TONY_LINE));
    await store.storeEvent(
      STREAM,
      note(1, 'metro://whatsapp/a99-ghost/333@lid'),
    );

    expect(await collect(store, base, TONY)).toEqual([]);
    expect(await collect(store, base, BOTH)).toEqual([]);
  });

  test('withheld frames are reported, delivered ones are not', async () => {
    const store = storeFor(BOTH);
    const base = await store.storeEvent(STREAM, note(0, TONY_LINE));
    const leak = await store.storeEvent(STREAM, note(1, LISA_LINE));
    await store.storeEvent(STREAM, note(2, TONY_LINE));

    const withheld: [string, string | undefined][] = [];
    await store.replayEventsAfter(base, {
      scope: TONY,
      send: () => Promise.resolve(),
      onWithheld: (id, line) => withheld.push([id, line]),
    });
    expect(withheld).toEqual([[leak, LISA_LINE]]);
  });

  test('an unknown, stale or forged Last-Event-ID replays nothing', async () => {
    const store = storeFor(TONY);
    await store.storeEvent(STREAM, note(0, TONY_LINE));
    await store.storeEvent(STREAM, note(1, TONY_LINE));

    expect(await collect(store, `${STREAM}_9999`, TONY)).toEqual([]);
    expect(await collect(store, `${STREAM}_0`, TONY)).toEqual([]);
    expect(await collect(store, 'garbage', TONY)).toEqual([]);
    expect(await collect(store, '', TONY)).toEqual([]);
    expect(await collect(store, 'other-stream_1', TONY)).toEqual([]);
  });
});
