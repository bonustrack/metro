import { describe, expect, spyOn, test } from 'bun:test';
import type { Chat, User } from '@mtcute/bun';
import { ChannelDirectory, DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { fetchChannels, type DialogSource } from '../src/channels.ts';

type DialogOptions = Parameters<DialogSource['iterDialogs']>[0];

function dialog(id: number, name: string, chatType?: Chat['chatType']) {
  const peer: Pick<User | Chat, 'id' | 'type' | 'displayName'> & Partial<Pick<Chat, 'chatType'>> = {
    id,
    type: chatType ? 'chat' : 'user',
    displayName: name,
    ...(chatType ? { chatType } : {}),
  };
  return {
    peer,
    get lastMessage(): never {
      throw new Error('Discovery must not read message content');
    },
    get draft(): never {
      throw new Error('Discovery must not read drafts');
    },
  };
}

type Row = ReturnType<typeof dialog>;

function fixture(pinned: Row[], archivedPinned: Row[], unpinned: Row[]) {
  const calls: DialogOptions[] = [];
  let yielded = 0;
  const source: DialogSource = {
    async *iterDialogs(params) {
      await Promise.resolve();
      calls.push(params);
      const rows = params.pinned === 'exclude' ? unpinned : params.archived === 'only' ? archivedPinned : pinned;
      for (const row of rows.slice(0, params.limit)) {
        yielded++;
        yield row;
      }
    },
  };
  return { source, calls, yielded: () => yielded };
}

function listing(source: DialogSource) {
  const directory = new ChannelDirectory();
  return (args: Record<string, unknown> = {}, account = 'work') =>
    directory.list(account, args, () => fetchChannels(account, source));
}

describe('telegram channel discovery', () => {
  test('discovers normal and archived dialogs without history and projects metadata only', async () => {
    const f = fixture(
      [dialog(20, 'Quiet direct')],
      [dialog(-10030, 'Archived group', 'supergroup')],
      [dialog(-40, 'Old group', 'group'), dialog(-10050, 'News', 'channel')],
    );
    const result = await listing(f.source)();
    expect(result.channels).toEqual([
      { id: '-10030', line: 'metro://telegram/work/-10030', name: 'Archived group', kind: 'group' },
      { id: '-10050', line: 'metro://telegram/work/-10050', name: 'News', kind: 'channel' },
      { id: '-40', line: 'metro://telegram/work/-40', name: 'Old group', kind: 'group' },
      { id: '20', line: 'metro://telegram/work/20', name: 'Quiet direct', kind: 'direct' },
    ]);
    expect(result.capability).toEqual({ supported: true, complete: true, source: 'remote' });
    expect(result.next_cursor).toBeUndefined();
    expect(f.calls).toEqual([
      { pinned: 'only', archived: 'exclude', limit: 5001, chunkSize: 100 },
      { pinned: 'only', archived: 'only', limit: 5000, chunkSize: 100 },
      { pinned: 'exclude', archived: 'keep', limit: 4999, chunkSize: 100 },
    ]);
  });

  test('deduplicates pinned dialogs and pages a stable sorted snapshot without another scan', async () => {
    const rows = [dialog(8, 'Eight'), dialog(7, 'Seven'), dialog(9, 'Nine')];
    const f = fixture([dialog(9, 'Nine')], [dialog(9, 'Nine')], rows);
    const list = listing(f.source);
    const first = await list({ limit: 1 });
    expect(first.channels.map((row) => row.id)).toEqual(['7']);
    expect(first.capability.complete).toBe(false);
    expect(typeof first.next_cursor).toBe('string');
    rows.push(dialog(6, 'Six'));
    const second = await list({ limit: 1, cursor: first.next_cursor });
    const last = await list({ limit: 1, cursor: second.next_cursor });
    expect(second.channels.map((row) => row.id)).toEqual(['8']);
    expect(last.channels.map((row) => row.id)).toEqual(['9']);
    expect(last.next_cursor).toBeUndefined();
    expect(last.capability.complete).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  test('searches names, ids and canonical lines case-insensitively', async () => {
    const f = fixture([], [], [dialog(-10055, 'Dormant Work', 'supergroup'), dialog(6, 'Other')]);
    const list = listing(f.source);
    for (const query of ['DORMANT work', '-10055', 'METRO://TELEGRAM/WORK/-10055']) {
      const result = await list({ query });
      expect(result.channels.map((row) => row.id)).toEqual(['-10055']);
    }
    expect((await list({ query: 'No match' })).channels).toEqual([]);
    expect(f.calls.every((call) => call.filter === undefined && call.folder === undefined)).toBe(true);
  });

  test('uses default and requested page sizes across more than one SDK chunk', async () => {
    const f = fixture([], [], Array.from({ length: 205 }, (_, i) => dialog(i + 1, `Chat ${i + 1}`)));
    const list = listing(f.source);
    const first = await list();
    const second = await list({ limit: 100, cursor: first.next_cursor });
    const third = await list({ limit: 100, cursor: second.next_cursor });
    expect(first.channels).toHaveLength(50);
    expect(second.channels).toHaveLength(100);
    expect(third.channels).toHaveLength(55);
    expect(third.capability.complete).toBe(true);
    expect(third.next_cursor).toBeUndefined();
    expect(new Set([...first.channels, ...second.channels, ...third.channels].map((row) => row.id)).size).toBe(205);
    expect(f.calls).toHaveLength(3);
  });

  test('rejects invalid options and account or query mismatched cursors without scanning', async () => {
    const f = fixture([], [], [dialog(1, 'One'), dialog(2, 'Two')]);
    const list = listing(f.source);
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: 'q'.repeat(201) }, { cursor: '' }]) {
      await expect(list(args)).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
    const first = await list({ limit: 1 });
    await expect(list({ cursor: first.next_cursor }, 'other')).rejects.toThrow('Invalid or expired');
    await expect(list({ cursor: first.next_cursor, query: 'One' })).rejects.toThrow('Invalid or expired');
    expect(f.calls).toHaveLength(3);
  });

  test('bounds all scans together and keeps a truncated directory partial on its last page', async () => {
    const f = fixture(
      [dialog(9001, 'Pinned')],
      [dialog(9002, 'Archived pinned')],
      Array.from({ length: DIRECTORY_LIMIT + 20 }, (_, i) => dialog(i + 1, `Chat ${i + 1}`)),
    );
    const list = listing(f.source);
    let result = await list({ limit: 100 });
    let count = result.channels.length;
    while (result.next_cursor) {
      expect(result.capability.complete).toBe(false);
      result = await list({ limit: 100, cursor: result.next_cursor });
      count += result.channels.length;
    }
    expect(count).toBe(DIRECTORY_LIMIT);
    expect(result.capability.complete).toBe(false);
    expect(result.capability.reason).toContain('partial');
    expect(f.calls).toHaveLength(3);
    expect(f.yielded()).toBe(DIRECTORY_LIMIT + 1);
  });

  test('ends a nonconforming iterator at the scan bound', async () => {
    let yielded = 0;
    const source: DialogSource = {
      async *iterDialogs() {
        await Promise.resolve();
        while (true) {
          yielded++;
          yield dialog(yielded, 'Pinned');
        }
      },
    };
    const result = await fetchChannels('work', source);
    expect(yielded).toBe(DIRECTORY_LIMIT + 1);
    expect(result.channels).toHaveLength(DIRECTORY_LIMIT + 1);
    expect(result.capability.complete).toBe(false);
  });

  test('stops after a slow page without requesting more dialogs', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(0);
    let requestedMore = false;
    const source: DialogSource = {
      async *iterDialogs() {
        await Promise.resolve();
        yield dialog(1, 'First');
        now.mockReturnValue(30_000);
        yield dialog(2, 'Slow page');
        requestedMore = true;
        yield dialog(3, 'Not requested');
      },
    };
    try {
      const result = await fetchChannels('work', source);
      expect(result.channels.map((channel) => channel.id)).toEqual(['1', '2']);
      expect(result.capability.complete).toBe(false);
      expect(result.capability.reason).toContain('time limit');
      expect(requestedMore).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  test('checks the deadline before starting the next folder scan', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(0);
    let calls = 0;
    const source: DialogSource = {
      async *iterDialogs() {
        await Promise.resolve();
        calls++;
        yield dialog(1, 'First');
        now.mockReturnValue(30_000);
      },
    };
    try {
      const result = await fetchChannels('work', source);
      expect(calls).toBe(1);
      expect(result.capability.complete).toBe(false);
      expect(result.capability.reason).toContain('time limit');
    } finally {
      now.mockRestore();
    }
  });

  test('an exactly full scan is complete and an empty account is not unsupported', async () => {
    const full = fixture([], [], Array.from({ length: DIRECTORY_LIMIT }, (_, i) => dialog(i + 1, 'Chat')));
    expect((await fetchChannels('work', full.source)).capability.complete).toBe(true);
    const empty = await listing(fixture([], [], []).source)();
    expect(empty).toEqual({ channels: [], capability: { supported: true, complete: true, source: 'remote' } });
  });

  test('remote failures are surfaced rather than reported as empty discovery', async () => {
    const source: DialogSource = {
      async *iterDialogs() {
        await Promise.resolve();
        yield dialog(1, 'One');
        throw new Error('FLOOD_WAIT_12');
      },
    };
    await expect(listing(source)()).rejects.toThrow('FLOOD_WAIT_12');
  });
});
