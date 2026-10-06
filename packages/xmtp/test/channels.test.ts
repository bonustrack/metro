import { describe, expect, spyOn, test } from 'bun:test';
import { ChannelDirectory, DIRECTORY_LIMIT, type ChannelList } from '@metro-labs/core/stations/channel-directory';
import { ListConversationsOrderBy, type ListConversationsOptions } from '@xmtp/node-sdk';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { listChannels, loadChannels } from '../src/channels.ts';
import { network, syncConversation } from '../src/network.ts';
import { xmtpStation } from '../src/station.ts';

const account = 'discovery-fixture';

function forbidden(): never {
  throw new Error('Discovery must not access messages, members or profiles');
}

class QuietGroup {
  constructor(readonly id: string, private readonly title: string) {}
  get name(): string { return this.title; }
  get messages(): never { return forbidden(); }
  get members(): never { return forbidden(); }
  get sync(): never { return forbidden(); }
  get imageUrl(): never { return forbidden(); }
}

const quietDm = { id: 'quiet-dm', messages: forbidden, peerInboxId: forbidden };

function fixture(rows: { id: string; name?: string }[] = [
  quietDm, new QuietGroup('quiet-group', 'Dormant project'),
]) {
  const state = { syncs: 0, lists: 0, options: undefined as ListConversationsOptions | undefined, rows };
  const source = {
    sync: async () => { state.syncs++; },
    list: async (options: ListConversationsOptions) => {
      expect(state.syncs).toBeGreaterThan(0);
      state.lists++;
      state.options = options;
      return state.rows.slice(0, options.limit);
    },
    syncAll: forbidden,
    getMessageById: forbidden,
    createDm: forbidden,
    getConversationById: forbidden,
  };
  return { state, source, load: () => loadChannels(account, source) };
}

describe('XMTP channel discovery', () => {
  test('lists metadata without recent messages, profile or member lookups', async () => {
    const { state, load } = fixture();
    const result = await new ChannelDirectory().list(account, {}, load);
    expect(xmtpStation.discoversChannels).toBe(true);
    expect(state.syncs).toBe(1);
    expect(state.lists).toBe(1);
    expect(state.options).toEqual({
      limit: DIRECTORY_LIMIT + 1,
      includeDuplicateDms: false,
      orderBy: ListConversationsOrderBy.CreatedAt,
    });
    expect(result.channels).toEqual([
      { id: 'quiet-dm', line: `metro://xmtp/${account}/quiet-dm`, kind: 'direct' },
      { id: 'quiet-group', line: `metro://xmtp/${account}/quiet-group`, name: 'Dormant project', kind: 'group' },
    ]);
    expect(result.capability).toMatchObject({ supported: true, complete: false, source: 'mixed' });
    expect(result.capability.reason).toContain('other devices');
    expect(result.capability.reason).toContain('locally stored metadata');
  });

  test('an unnamed group stays a group and an empty directory stays partial', async () => {
    const { load } = fixture([new QuietGroup('unnamed', '')]);
    expect((await load()).channels).toEqual([
      { id: 'unnamed', line: `metro://xmtp/${account}/unnamed`, kind: 'group' },
    ]);
    expect(await new ChannelDirectory().list(account, {}, fixture([]).load)).toMatchObject({
      channels: [], capability: { supported: true, complete: false, source: 'mixed' },
    });
  });

  test('deduplicates and pages a stable snapshot without another SDK call', async () => {
    const { state, load } = fixture([
      new QuietGroup('b', 'Second'), { id: 'a' }, { id: 'a' }, new QuietGroup('c', 'Third'),
    ]);
    const directory = new ChannelDirectory();
    const first = await directory.list(account, { limit: 1 }, load);
    expect(first.channels.map((row) => row.id)).toEqual(['a']);
    expect(first.next_cursor).toBeString();
    state.rows = [{ id: 'new-arrival' }];
    const second = await directory.list(account, { limit: 2, cursor: first.next_cursor }, load);
    expect(second.channels.map((row) => row.id)).toEqual(['b', 'c']);
    expect(second.next_cursor).toBeUndefined();
    expect(second.capability.complete).toBe(false);
    expect(state.syncs).toBe(1);
    expect(state.lists).toBe(1);
  });

  test.each(['DORMANT', 'QUIET-GROUP', `metro://xmtp/${account}/QUIET-GROUP`])(
    'searches names, ids and canonical lines without content: %s', async (query) => {
      const { load } = fixture();
      const result = await new ChannelDirectory().list(account, { query }, load);
      expect(result.channels.map((row) => row.id)).toEqual(['quiet-group']);
    },
  );

  test('bounds the SDK request and marks a truncated installation partial', async () => {
    const rows = Array.from({ length: DIRECTORY_LIMIT + 20 }, (_, index) => ({ id: `conversation-${index}` }));
    const { state, load } = fixture(rows);
    const snapshot = await load();
    expect(snapshot.channels).toHaveLength(DIRECTORY_LIMIT + 1);
    expect(state.options?.limit).toBe(DIRECTORY_LIMIT + 1);
    const result = await new ChannelDirectory().list(account, { query: `conversation-${DIRECTORY_LIMIT}` }, async () => snapshot);
    expect(result.channels).toEqual([]);
    expect(result.capability.complete).toBe(false);
    expect(result.capability.reason).toContain('5000');
  });

  test('rejects invalid arguments before sync and does not disguise sync failure', async () => {
    const { state, source, load } = fixture();
    const directory = new ChannelDirectory();
    await expect(directory.list(account, { limit: 101 }, load)).rejects.toThrow();
    await expect(directory.list(account, { query: 'x'.repeat(201) }, load)).rejects.toThrow();
    expect(state.syncs).toBe(0);
    source.sync = async () => { throw new Error('sync refused'); };
    await expect(load()).rejects.toThrow('sync refused');
    expect(state.lists).toBe(0);
  });

  test.each([{}, { account: '' }, { account: 1 }, { line: 'metro://xmtp/implicit/quiet-dm' }])(
    'requires an explicit account: %j', async (args) => {
      await expect(listChannels('test', args)).rejects.toThrow('requires an account');
    },
  );

  test('coalesces simultaneous first-page syncs without retaining a completed sync', async () => {
    const { state, load } = fixture();
    const results = await Promise.all(Array.from({ length: 29 }, load));
    expect(results).toHaveLength(29);
    expect(state.syncs).toBe(1);
    await load();
    expect(state.syncs).toBe(2);
  });

  test('discovery shares the existing conversation synchronization queue', async () => {
    const events: string[] = [];
    let release = () => {};
    let started = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    const conversation = syncConversation({}, {
      id: 'existing',
      sync: async () => {
        events.push('conversation-start');
        started();
        await blocked;
        events.push('conversation-end');
      },
    });
    await running;
    const { source, load } = fixture();
    const originalSync = source.sync;
    source.sync = async () => { events.push('directory'); await originalSync(); };
    const discovery = load();
    release();
    await Promise.all([conversation, discovery]);
    expect(events).toEqual(['conversation-start', 'conversation-end', 'directory']);
  });

  test('cursor pages remain local during cooldown while new discovery stays gated', async () => {
    const { source, state } = fixture();
    accounts.set(account, { cfg: { id: account }, client: { conversations: source } } as unknown as Account);
    const writes: string[] = [];
    const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    function response(id: string): { result?: ChannelList; error?: string; code?: string } {
      return writes.flatMap((chunk) => chunk.trim().split('\n')).map((raw) => JSON.parse(raw))
        .find((row) => row.op === 'response' && row.id === id);
    }
    const call = (id: string, args: Record<string, unknown>) =>
      handleCall({ op: 'call', id, action: 'listChannels', args: { account, ...args } });
    try {
      await call('first', { limit: 1 });
      const cursor = response('first').result?.next_cursor;
      expect(cursor).toBeString();
      const cooldown = spyOn(network, 'remaining').mockReturnValue(60_000);
      try {
        await call('next', { cursor });
        expect(response('next').error).toBeUndefined();
        expect(response('next').result?.channels.map((entry) => entry.id)).toEqual(['quiet-group']);
        await call('fresh', {});
        expect(response('fresh').error).toContain('XMTP is rate limited');
        await call('invalid', { cursor: 'missing-cursor' });
        expect(response('invalid').error).toContain('Invalid or expired channel cursor');
        expect(state.syncs).toBe(1);
        expect(state.lists).toBe(1);
      } finally { cooldown.mockRestore(); }
    } finally {
      output.mockRestore();
      accounts.delete(account);
    }
  });

  test('refuses old cursors after an account is removed or replaced under the same id', async () => {
    const original = fixture([{ id: 'old-a' }, { id: 'old-b' }]);
    const replacement = fixture([{ id: 'new-only' }]);
    const writes: string[] = [];
    const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    const call = (args: Record<string, unknown>) =>
      listChannels('lifecycle', { account, ...args });
    accounts.set(account, { cfg: { id: account }, client: { conversations: original.source } } as unknown as Account);
    try {
      await call({ limit: 1 });
      const first: { result: ChannelList } = JSON.parse(writes[0] ?? '{}');
      const cursor = first.result.next_cursor;
      expect(cursor).toBeString();
      accounts.delete(account);
      await expect(call({ cursor })).rejects.toThrow('unknown account');
      accounts.set(account, { cfg: { id: account }, client: { conversations: replacement.source } } as unknown as Account);
      await expect(call({ cursor })).rejects.toThrow('Invalid or expired channel cursor');
      expect(replacement.state.syncs).toBe(0);
      expect(replacement.state.lists).toBe(0);
      await call({});
      const fresh: { result: ChannelList } = JSON.parse(writes[1] ?? '{}');
      expect(fresh.result.channels.map(({ id }) => id)).toEqual(['new-only']);
      expect(original.state.syncs).toBe(1);
      expect(original.state.lists).toBe(1);
    } finally {
      output.mockRestore();
      accounts.delete(account);
    }
  });

  test('registers the train action and refuses an unknown account', async () => {
    const write = spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await handleCall({ op: 'call', id: 'discovery', action: 'listChannels', args: {} });
      const output = write.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('listChannels requires an account');
      expect(output).not.toContain('unknown action');
    } finally {
      write.mockRestore();
    }
    await expect(listChannels('test', { account: 'missing-discovery-fixture' })).rejects.toThrow('unknown account');
  });
});
