import { describe, expect, test } from 'bun:test';
import { NetworkBackoff, SyncRequests } from '../src/network.ts';

const exhausted = () => new Error('GetIdentityUpdates: Some resource has been exhausted; 1 exceeds rate limit');

function clock() {
  let now = 1_000_000;
  const backoff = new NetworkBackoff(() => now);
  return { backoff, advance: (ms: number) => { now += ms; } };
}

describe('XMTP request backoff', () => {
  test('a failed write is never retried, and the cooldown rejects bursts before the SDK', async () => {
    const { backoff, advance } = clock();
    let calls = 0;
    const error = exhausted();
    const send = () => backoff.run(async () => { calls++; throw error; });
    await expect(send()).rejects.toBe(error);
    const burst = await Promise.allSettled(Array.from({ length: 29 }, send));
    expect(calls).toBe(1);
    expect(burst.every((result) => result.status === 'rejected')).toBe(true);
    const refusal = burst[0];
    if (refusal?.status === 'rejected') {
      expect(refusal.reason.code).toBe('xmtp_rate_limited');
      expect(refusal.reason.retryAfterMs).toBe(60_000);
      expect(refusal.reason.message).toContain('GetIdentityUpdates');
    }
    advance(60_000);
    await expect(send()).rejects.toBe(error);
    expect(calls).toBe(2);
    expect(backoff.remaining()).toBe(120_000);
  });

  test.each([
    { status: 429, headers: new Headers({ 'retry-after': '420' }) },
    { code: 8, retryAfterMs: 420_000 },
    { status: 429, response: { headers: { 'retry-after': new Date(1_420_000).toUTCString() } } },
    { code: 8, metadata: { get: () => ['420'] } },
  ])('honors retry-after beyond the local backoff cap: %j', async (error) => {
    const { backoff, advance } = clock();
    await expect(backoff.run(async () => { throw error; })).rejects.toBe(error);
    expect(backoff.remaining()).toBe(420_000);
    advance(419_999);
    await expect(backoff.run(async () => 'too early')).rejects.toThrow('retry in 1s');
    advance(1);
    expect(await backoff.run(async () => 'ready')).toBe('ready');
  });

  test('a simultaneous failure does not multiply the cooldown, later failures do', () => {
    const { backoff, advance } = clock();
    backoff.note(exhausted());
    for (let i = 0; i < 29; i++) backoff.note(exhausted());
    expect(backoff.remaining()).toBe(60_000);
    for (const ms of [120_000, 240_000, 300_000, 300_000]) {
      advance(backoff.remaining());
      backoff.note(exhausted());
      expect(backoff.remaining()).toBe(ms);
    }
    advance(backoff.remaining() + 300_000);
    backoff.note(exhausted());
    expect(backoff.remaining()).toBe(60_000);
  });

  test('a longer server retry-after extends a cooldown already in progress', () => {
    const { backoff } = clock();
    backoff.note(exhausted());
    backoff.note({ code: 8, retryAfterMs: 600_000 });
    expect(backoff.remaining()).toBe(600_000);
  });

  test('unrelated errors propagate without imposing an XMTP rate-limit cooldown', async () => {
    const { backoff } = clock();
    const error = new Error('invalid group');
    await expect(backoff.run(async () => { throw error; })).rejects.toBe(error);
    expect(backoff.remaining()).toBe(0);
    expect(await backoff.run(async () => 'next')).toBe('next');
  });
});

describe('conversation sync scheduling', () => {
  test('29 simultaneous reads of one conversation share one sync, without a TTL', async () => {
    const { backoff } = clock();
    const syncs = new SyncRequests(backoff);
    const client = {};
    let calls = 0;
    const sync = async () => { calls++; return calls; };
    const reads = Array.from({ length: 29 }, () => syncs.run(client, 'group', sync));
    expect(new Set(reads).size).toBe(1);
    expect(await Promise.all(reads)).toEqual(Array(29).fill(1));
    expect(await syncs.run(client, 'group', sync)).toBe(2);
  });

  test('a 29-channel burst has one active sync and loses no requests', async () => {
    const syncs = new SyncRequests(clock().backoff);
    const client = {};
    let active = 0;
    let peak = 0;
    let calls = 0;
    const sync = async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return ++calls;
    };
    const result = await Promise.all(Array.from({ length: 29 }, (_, i) => syncs.run(client, `group-${i}`, sync)));
    expect(result).toHaveLength(29);
    expect(calls).toBe(29);
    expect(peak).toBe(1);
  });

  test('separate clients never share a sync even with the same conversation id', async () => {
    const syncs = new SyncRequests(clock().backoff);
    const results = await Promise.all([
      syncs.run({}, 'group', async () => 'first'),
      syncs.run({}, 'group', async () => 'second'),
    ]);
    expect(results).toEqual(['first', 'second']);
  });

  test('the first rate limit stops queued syncs, then recovery works without cached failure', async () => {
    const { backoff, advance } = clock();
    const syncs = new SyncRequests(backoff);
    const client = {};
    let calls = 0;
    const results = await Promise.allSettled(Array.from({ length: 29 }, (_, i) => syncs.run(client, `${i}`, async () => {
      calls++;
      throw exhausted();
    })));
    expect(calls).toBe(1);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    advance(60_000);
    expect(await syncs.run(client, '0', async () => 'recovered')).toBe('recovered');
  });

  test('a sync queued for 30s expires without starting late work', async () => {
    let now = 0;
    const syncs = new SyncRequests(clock().backoff, () => now);
    const client = {};
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = syncs.run(client, 'first', () => blocked);
    await Promise.resolve();
    let calls = 0;
    const second = syncs.run(client, 'second', async () => { calls++; });
    now = 30_000;
    release();
    await first;
    await expect(second).rejects.toThrow('XMTP sync waited 30s');
    expect(calls).toBe(0);
  });

  test('ordinary sync failures also release the queue and all coalesced callers see the error', async () => {
    const syncs = new SyncRequests(clock().backoff);
    const client = {};
    const error = new Error('sync failed');
    const first = syncs.run(client, 'group', async () => { throw error; });
    const second = syncs.run(client, 'group', async () => 'must not run');
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(await syncs.run(client, 'group', async () => 'fresh')).toBe('fresh');
  });
});
