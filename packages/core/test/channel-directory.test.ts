import { describe, expect, spyOn, test } from 'bun:test';
import {
  ChannelDirectory,
  channelOptions,
  DIRECTORY_LIMIT,
  type ChannelEntry,
  type ChannelSnapshot,
} from '../src/stations/channel-directory.js';

const entry = (id: string, name = id, account = 'fixture'): ChannelEntry => ({
  id,
  line: `metro://xmtp/${account}/${id}`,
  kind: 'group',
  name,
});
const snapshot = (channels: ChannelEntry[], complete = true): ChannelSnapshot => ({
  channels,
  capability: {
    supported: true,
    complete,
    source: complete ? 'remote' : 'local',
    ...(complete ? {} : { reason: 'Known conversations only.' }),
  },
});

describe('channel directory pages', () => {
  test('finds quiet channel names without messages and projects metadata only', async () => {
    const directory = new ChannelDirectory();
    const provider = { ...entry('old-id', 'Quiet Project'), body: 'private body', token: 'secret' };
    const result = await directory.list('fixture', { query: '  QUIET  ' }, async () => snapshot([provider]));
    expect(result.channels).toEqual([entry('old-id', 'Quiet Project')]);
    expect(result.capability.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private body');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('matches the full source name before clipping returned metadata', async () => {
    const directory = new ChannelDirectory();
    const name = `${'A'.repeat(256)} Quiet Project`;
    const result = await directory.list('fixture', { query: 'quiet project' }, async () => snapshot([entry('long-name', name)]));
    expect(result.channels).toEqual([entry('long-name', 'A'.repeat(256))]);
    expect(result.capability.complete).toBe(true);
  });

  test('deduplicates by canonical line and pages a stable snapshot in deterministic order', async () => {
    const directory = new ChannelDirectory();
    let loads = 0;
    const load = async () => {
      loads++;
      return snapshot([entry('c'), entry('a'), entry('b'), entry('a')]);
    };
    const first = await directory.list('fixture', { limit: 1 }, load);
    expect(first.channels.map((row) => row.id)).toEqual(['a']);
    expect(first.capability.complete).toBe(false);
    expect(first.next_cursor).toBeString();
    const next = await directory.list('fixture', { cursor: first.next_cursor, limit: 2 }, load);
    expect(next.channels.map((row) => row.id)).toEqual(['b', 'c']);
    expect(next.capability.complete).toBe(true);
    expect(next.next_cursor).toBeUndefined();
    expect(loads).toBe(1);
    const replay = await directory.list('fixture', { cursor: first.next_cursor, limit: 2 }, load);
    expect(replay).toEqual(next);
  });

  test('binds a cursor to account and normalized query before a provider call', async () => {
    const directory = new ChannelDirectory();
    const first = await directory.list('fixture', { query: 'project', limit: 1 }, async () =>
      snapshot([entry('a', 'Project A'), entry('b', 'Project B')]));
    let loads = 0;
    const load = async () => { loads++; return snapshot([]); };
    await expect(directory.list('another', { query: 'project', cursor: first.next_cursor }, load)).rejects.toThrow('Invalid or expired');
    await expect(directory.list('fixture', { query: 'changed', cursor: first.next_cursor }, load)).rejects.toThrow('Invalid or expired');
    const next = await directory.list('fixture', { query: ' PROJECT ', cursor: first.next_cursor }, load);
    expect(next.channels.map((row) => row.id)).toEqual(['b']);
    expect(loads).toBe(0);
  });

  test('rejects expired and unknown cursors without reloading or changing account', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const directory = new ChannelDirectory();
      const first = await directory.list('fixture', { limit: 1 }, async () => snapshot([entry('a'), entry('b')]));
      now.mockReturnValue(301000);
      const load = async () => { throw new Error('provider must not run'); };
      await expect(directory.list('fixture', { cursor: first.next_cursor }, load)).rejects.toThrow('Invalid or expired');
      await expect(directory.list('fixture', { cursor: 'invented' }, load)).rejects.toThrow('Invalid or expired');
    } finally {
      now.mockRestore();
    }
  });

  test('exhausting a local cache or a query with no matches never means complete', async () => {
    const directory = new ChannelDirectory();
    const result = await directory.list('fixture', { query: 'absent' }, async () => snapshot([entry('old')], false));
    expect(result.channels).toEqual([]);
    expect(result.next_cursor).toBeUndefined();
    expect(result.capability).toEqual({ supported: true, complete: false, source: 'local', reason: 'Known conversations only.' });
  });

  test('caps entry scans and labels a match omitted by the cap as incomplete', async () => {
    const directory = new ChannelDirectory();
    const channels = Array.from({ length: DIRECTORY_LIMIT + 1 }, (_, i) => entry(String(i)));
    const result = await directory.list('fixture', { query: String(DIRECTORY_LIMIT) }, async () => snapshot(channels));
    expect(result.channels).toEqual([]);
    expect(result.capability.complete).toBe(false);
    expect(result.capability.reason).toContain('entry limit');
  });

  test('drops foreign-account and oversized identifiers instead of altering canonical lines', async () => {
    const directory = new ChannelDirectory();
    const result = await directory.list('fixture', {}, async () => snapshot([
      entry('allowed'), entry('foreign', 'Foreign', 'other'), entry('x'.repeat(1025)),
    ]));
    expect(result.channels).toEqual([entry('allowed')]);
    expect(result.capability.complete).toBe(false);
  });

  test('bounds stored metadata bytes, names and final serialized pages', async () => {
    const directory = new ChannelDirectory();
    const channels = Array.from({ length: DIRECTORY_LIMIT }, (_, i) => entry(`${String(i).padStart(5, '0')}-${'x'.repeat(900)}`, '😀'.repeat(300)));
    let page = await directory.list('fixture', { limit: 100 }, async () => snapshot(channels));
    const seen = new Set<string>();
    while (true) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
      expect(page.capability.complete).toBe(false);
      for (const channel of page.channels) {
        expect(Array.from(channel.name ?? '')).toHaveLength(256);
        expect(seen.has(channel.id)).toBe(false);
        seen.add(channel.id);
      }
      if (!page.next_cursor) break;
      page = await directory.list('fixture', { limit: 100, cursor: page.next_cursor }, async () => { throw new Error('no reload'); });
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(seen.size).toBeLessThan(DIRECTORY_LIMIT);
  });

  test('bounds retained cursors and refuses evicted pages explicitly', async () => {
    const directory = new ChannelDirectory();
    const first = await directory.list('fixture', { limit: 1 }, async () => snapshot([entry('a'), entry('b')]));
    for (let i = 0; i < 32; i++)
      await directory.list('fixture', { limit: 1 }, async () => snapshot([entry('a'), entry('b')]));
    await expect(directory.list('fixture', { cursor: first.next_cursor }, async () => snapshot([]))).rejects.toThrow('Invalid or expired');
  });

  test('validates limits and query/cursor types before loading', async () => {
    expect(channelOptions({})).toEqual({ query: '', limit: 50 });
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { limit: NaN },
      { query: 1 }, { query: 'a'.repeat(201) }, { cursor: 2 }, { cursor: '' }, { cursor: 'a'.repeat(2049) }]) {
      await expect(new ChannelDirectory().list('fixture', args, async () => { throw new Error('provider called'); })).rejects.not.toThrow('provider called');
    }
  });
});
