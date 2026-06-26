import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BoundedEventStore } from '../src/mcp/event-store.ts';

const STREAM = '_GET_stream';

const note = (n: number): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: { n },
  }) as unknown as JSONRPCMessage;

const collect = async (
  store: BoundedEventStore,
  lastEventId: string,
): Promise<JSONRPCMessage[]> => {
  const out: JSONRPCMessage[] = [];
  await store.replayEventsAfter(lastEventId, {
    send: (_id, message) => {
      out.push(message);
      return Promise.resolve();
    },
  });
  return out;
};

describe('BoundedEventStore', () => {
  test('replays events stored after Last-Event-ID, in order', async () => {
    const store = new BoundedEventStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await store.storeEvent(STREAM, note(i)));

    const replayed = await collect(store, ids[1]);
    expect(replayed.map((m) => (m as { params: { n: number } }).params.n)).toEqual(
      [2, 3, 4],
    );
  });

  test('replay is filtered to the same stream', async () => {
    const store = new BoundedEventStore();
    const a0 = await store.storeEvent('stream-a', note(0));
    await store.storeEvent('stream-b', note(99));
    await store.storeEvent('stream-a', note(1));

    const replayed = await collect(store, a0);
    expect(replayed.map((m) => (m as { params: { n: number } }).params.n)).toEqual(
      [1],
    );
  });

  test('evicts past the cap but still replays what remains', async () => {
    const store = new BoundedEventStore(3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await store.storeEvent(STREAM, note(i)));

    const replayed = await collect(store, ids[3]);
    expect(replayed.map((m) => (m as { params: { n: number } }).params.n)).toEqual(
      [4, 5],
    );
    const evicted = await collect(store, ids[0]);
    expect(evicted).toEqual([]);
  });

  test('event ids are monotonic and map back to their stream', async () => {
    const store = new BoundedEventStore();
    const id0 = await store.storeEvent(STREAM, note(0));
    const id1 = await store.storeEvent(STREAM, note(1));
    expect(id0).not.toEqual(id1);
    expect(await store.getStreamIdForEventId(id1)).toEqual(STREAM);
    const seq0 = Number(id0.slice(id0.lastIndexOf('_') + 1));
    const seq1 = Number(id1.slice(id1.lastIndexOf('_') + 1));
    expect(seq1).toBeGreaterThan(seq0);
  });

  test('a notification stored while no stream is attached is later replayable', async () => {
    const store = new BoundedEventStore();
    const baseline = await store.storeEvent(STREAM, note(0));
    const duringGap = await store.storeEvent(STREAM, note(42));
    expect(await store.getStreamIdForEventId(duringGap)).toEqual(STREAM);

    const replayed = await collect(store, baseline);
    expect(replayed.map((m) => (m as { params: { n: number } }).params.n)).toEqual(
      [42],
    );
  });
});
