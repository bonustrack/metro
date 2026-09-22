import { describe, expect, test } from 'bun:test';
import { makeProfileCache, nonEmpty } from '../src/stations/sender-profile.ts';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the sender profile cache', () => {
  test('peek never waits: it starts the lookup, answers null, and answers the value once it landed', async () => {
    let asked = 0;
    const cache = makeProfileCache(
      async (key) => {
        asked += 1;
        await tick(20);
        return { id: key, about: `about ${key}` };
      },
      { onError: () => undefined },
    );
    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('a')).toBeNull();
    await tick(40);
    expect(cache.peek('a')).toEqual({ id: 'a', about: 'about a' });
    expect(await cache.get('a')).toEqual({ id: 'a', about: 'about a' });
    expect(asked).toBe(1);
  });

  test('a failed lookup is reported, answers null, and is asked again next time', async () => {
    const errors: string[] = [];
    let calls = 0;
    const cache = makeProfileCache(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve({ id: 'b', about: 'up' });
      },
      { onError: (key, err) => errors.push(`${key}: ${(err as Error).message}`) },
    );
    expect(await cache.get('b')).toBeNull();
    expect(errors).toEqual(['b: down']);
    expect(await cache.get('b')).toEqual({ id: 'b', about: 'up' });
  });

  test('a stale entry is refreshed and the cache stays bounded', async () => {
    let calls = 0;
    const cache = makeProfileCache(() => Promise.resolve({ id: 'c', about: String(++calls) }), { ttlMs: 5, max: 2, onError: () => undefined });
    expect(await cache.get('c')).toEqual({ id: 'c', about: '1' });
    await tick(10);
    expect(await cache.get('c')).toEqual({ id: 'c', about: '2' });
    await cache.get('d');
    await cache.get('e');
    expect(await cache.get('c')).toEqual({ id: 'c', about: '5' });
    expect(nonEmpty('  ')).toBeUndefined();
    expect(nonEmpty(' x ')).toBe('x');
  });
});
