import { describe, expect, spyOn, test } from 'bun:test';
import type { ChannelEntry } from '../src/stations/channel-directory.js';
import { ChannelPages, type ChannelPageLoader } from '../src/stations/channel-pages.js';

const entry = (id: string, name = id): ChannelEntry => ({ id, line: `metro://gmail/fixture/${id}`, name, kind: 'thread' });
const listing = (directory: ChannelPages, args: Record<string, unknown>, load: ChannelPageLoader, account = 'fixture') =>
  directory.list(account, args, load, 'Mailbox metadata only.');

const neverLoad: ChannelPageLoader = async () => { throw new Error('provider must not run'); };

describe('native channel pages', () => {
  test('keeps every unique thread across remote boundaries and buffered result pages', async () => {
    const directory = new ChannelPages();
    const calls: (string | undefined)[] = [];
    const load: ChannelPageLoader = async (token, limit) => {
      expect(limit).toBe(100);
      calls.push(token);
      return token === undefined
        ? { channels: [entry('a'), entry('a'), entry('b')], scanned: 3, next: 'second' }
        : { channels: [entry('b'), entry('c'), entry('d')], scanned: 3 };
    };
    let page = await listing(directory, { limit: 1 }, load);
    const ids = page.channels.map((row) => row.id);
    while (page.next_cursor) {
      expect(page.capability.complete).toBe(false);
      page = await listing(directory, { limit: 1, cursor: page.next_cursor }, load);
      ids.push(...page.channels.map((row) => row.id));
    }
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
    expect(calls).toEqual([undefined, 'second']);
    expect(page.capability).toMatchObject({ supported: true, complete: true, source: 'remote' });
  });

  test('empty filtered pages remain resumable and matching is a normalized substring', async () => {
    const directory = new ChannelPages();
    const load: ChannelPageLoader = async (token) => token === undefined
      ? { channels: [entry('old', 'Invoice')], scanned: 1, next: 'next' }
      : { channels: [entry('last', 'Quiet Project')], scanned: 1 };
    const first = await listing(directory, { query: '  PROJECT  ' }, load);
    expect(first.channels).toEqual([]);
    expect(first.next_cursor).toBeString();
    expect(first.capability.reason).toContain('even after an empty page');
    const next = await listing(directory, { query: 'project', cursor: first.next_cursor }, load);
    expect(next.channels).toEqual([entry('last', 'Quiet Project')]);
    expect(next.capability.complete).toBe(true);
    const byId = await listing(directory, { query: 'oLD' }, load);
    expect(byId.channels).toEqual([entry('old', 'Invoice')]);
    expect((await listing(directory, { query: 'subject:Invoice' }, load)).channels).toEqual([]);
  });

  test('matches a subject suffix beyond the displayed name limit', async () => {
    const name = `${'x'.repeat(300)} Quiet Project`;
    const page = await listing(new ChannelPages(), { query: 'quiet project' }, async () => ({ channels: [entry('a', name)], scanned: 1 }));
    expect(page.channels).toEqual([entry('a', 'x'.repeat(256))]);
    expect(page.capability.complete).toBe(true);
  });

  test('projects metadata only and does not retain caller mutations', async () => {
    const directory = new ChannelPages();
    const source = { ...entry('b'), body: 'private text', secret: 'secret value' };
    const first = await listing(directory, { limit: 1 }, async () => ({ channels: [entry('a'), source], scanned: 2 }));
    source.name = 'changed';
    const page = await listing(directory, { cursor: first.next_cursor }, neverLoad);
    expect(page.channels).toEqual([entry('b')]);
    if (page.channels[0]) page.channels[0].name = 'caller edit';
    const replay = await listing(directory, { cursor: first.next_cursor }, neverLoad);
    expect(replay.channels).toEqual([entry('b')]);
    expect(JSON.stringify(replay)).not.toContain('private text');
    expect(JSON.stringify(replay)).not.toContain('secret value');
  });

  test('rejects account and query mismatches, invalid options and unknown cursors before I/O', async () => {
    const directory = new ChannelPages();
    const first = await listing(directory, {}, async () => ({ channels: [entry('a')], scanned: 1, next: 'next' }));
    await expect(listing(directory, { cursor: first.next_cursor }, neverLoad, 'foreign')).rejects.toThrow('Invalid or expired');
    await expect(listing(directory, { cursor: first.next_cursor, query: 'changed' }, neverLoad)).rejects.toThrow('Invalid or expired');
    await expect(listing(directory, { cursor: 'invented' }, neverLoad)).rejects.toThrow('Invalid or expired');
    for (const args of [{ limit: 0 }, { limit: 101 }, { query: 1 }, { cursor: '' }])
      await expect(listing(directory, args, neverLoad)).rejects.not.toThrow('provider must not run');
  });

  test('replays an already fetched remote page without fetching it twice, even concurrently', async () => {
    const directory = new ChannelPages();
    const first = await listing(directory, {}, async () => ({ channels: [], scanned: 0, next: 'next' }));
    let calls = 0;
    const load: ChannelPageLoader = async () => { calls++; return { channels: [entry('b'), entry('c')], scanned: 2, next: 'last' }; };
    const args = { cursor: first.next_cursor, limit: 1 };
    const [next, concurrent] = await Promise.all([listing(directory, args, load), listing(directory, args, load)]);
    expect(next.channels).toEqual([entry('b')]);
    expect(concurrent.channels).toEqual(next.channels);
    expect(calls).toBe(1);
    const replay = await listing(directory, { ...args, limit: 2 }, neverLoad);
    expect(replay.channels).toEqual([entry('b'), entry('c')]);
    const remainder = await listing(directory, { cursor: next.next_cursor }, neverLoad);
    expect(remainder.channels).toEqual([entry('c')]);
  });

  test('a failed provider page can be retried without skipping threads', async () => {
    const directory = new ChannelPages();
    const first = await listing(directory, {}, async () => ({ channels: [entry('a')], scanned: 1, next: 'next' }));
    await expect(listing(directory, { cursor: first.next_cursor }, async () => { throw new Error('temporary'); })).rejects.toThrow('temporary');
    const page = await listing(directory, { cursor: first.next_cursor }, async (_token, _limit, seen) => {
      expect([...seen]).toEqual(['a']);
      return { channels: [entry('a'), entry('b')], scanned: 2 };
    });
    expect(page.channels).toEqual([entry('b')]);
  });

  test('cursor expiry is absolute and is not renewed by another page', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const directory = new ChannelPages();
      const first = await listing(directory, { limit: 1 }, async () => ({ channels: [entry('a'), entry('b'), entry('c')], scanned: 3 }));
      now.mockReturnValue(300000);
      const second = await listing(directory, { cursor: first.next_cursor, limit: 1 }, neverLoad);
      now.mockReturnValue(301000);
      await expect(listing(directory, { cursor: second.next_cursor }, neverLoad)).rejects.toThrow('Invalid or expired');
    } finally {
      now.mockRestore();
    }
  });

  test('retains at most 32 cursor tickets', async () => {
    const directory = new ChannelPages();
    const load: ChannelPageLoader = async () => ({ channels: [], scanned: 0, next: 'next' });
    const first = await listing(directory, {}, load);
    for (let i = 0; i < 32; i++) await listing(directory, {}, load);
    await expect(listing(directory, { cursor: first.next_cursor }, neverLoad)).rejects.toThrow('Invalid or expired');
  });

  test('stops at 5000 records with a truthful incomplete search result', async () => {
    const directory = new ChannelPages();
    let scans = 0;
    const load: ChannelPageLoader = async (_token, limit) => {
      scans += limit;
      return { channels: [entry('duplicate', 'Not the target')], scanned: limit, next: String(scans) };
    };
    let page = await listing(directory, { query: 'missing' }, load);
    while (page.next_cursor) page = await listing(directory, { query: 'missing', cursor: page.next_cursor }, load);
    expect(scans).toBe(5000);
    expect(page.channels).toEqual([]);
    expect(page.capability.complete).toBe(false);
    expect(page.capability.reason).toContain('5000');
    expect(page.capability.reason).toContain('does not cover the whole mailbox');
  });

  test('bounds stored metadata, truncates names and reports size limits', async () => {
    const directory = new ChannelPages();
    let offset = 0;
    const load: ChannelPageLoader = async (_token, limit) => {
      const channels = Array.from({ length: limit }, () => entry(`${offset++}-${'x'.repeat(900)}`, '𐐀'.repeat(300)));
      return { channels, scanned: limit, next: String(offset) };
    };
    let page = await listing(directory, { limit: 100 }, load);
    const ids = new Set<string>();
    while (true) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
      for (const row of page.channels) {
        expect(Array.from(row.name ?? '')).toHaveLength(256);
        expect(ids.has(row.id)).toBe(false);
        ids.add(row.id);
      }
      if (!page.next_cursor) break;
      page = await listing(directory, { limit: 100, cursor: page.next_cursor }, load);
    }
    expect(ids.size).toBeGreaterThan(100);
    expect(ids.size).toBeLessThan(5000);
    expect(page.capability.complete).toBe(false);
    expect(page.capability.reason).toContain('size or entry limit');
  });

  test('rejects repeated remote tokens and overlarge pages rather than skipping metadata', async () => {
    const directory = new ChannelPages();
    const first = await listing(directory, {}, async () => ({ channels: [], scanned: 0, next: 'same' }));
    await expect(listing(directory, { cursor: first.next_cursor }, async () => ({ channels: [], scanned: 0, next: 'same' }))).rejects.toThrow('repeated');
    await expect(listing(directory, {}, async () => ({ channels: [], scanned: 101 }))).rejects.toThrow('more channel metadata');
    await expect(listing(directory, {}, async () => ({ channels: [], scanned: 1, next: 'x'.repeat(16385) }))).rejects.toThrow('invalid channel page token');
  });

  test('drops invalid or foreign-account entries and labels the listing incomplete', async () => {
    const foreign = { ...entry('foreign'), line: 'metro://gmail/other/foreign' };
    const page = await listing(new ChannelPages(), {}, async () => ({ channels: [entry('a'), foreign, entry('x'.repeat(1025))], scanned: 3 }));
    expect(page.channels).toEqual([entry('a')]);
    expect(page.capability.complete).toBe(false);
    expect(page.next_cursor).toBeUndefined();
  });
});
