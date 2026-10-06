import { expect, spyOn, test } from 'bun:test';
import type { ChannelList } from '@metro-labs/core/stations/channel-directory';
import { ChannelType, Client, PermissionFlagsBits } from 'discord.js';
import { discordChannelSource } from '../src/channel-source.js';
import { loadDiscordChannels } from '../src/channels.js';
import { accounts } from '../src/accounts.js';
import { handleCall } from '../src/actions.js';

const VIEW = String(PermissionFlagsBits.ViewChannel);

function rawChannel(id: string, type = ChannelType.GuildText, parent = '200') {
  return {
    id,
    guild_id: '100',
    name: `Quiet ${id}`,
    type,
    parent_id: parent,
    permission_overwrites: [],
    thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: '2026-01-01T00:00:00Z' },
  };
}

function sdkFixture(denySelf = false) {
  const client = new Client({ intents: [] });
  Object.defineProperty(client, 'user', { value: { id: '900' }, writable: true });
  const calls: string[] = [];
  const network = spyOn(client.rest, 'request').mockImplementation(() => {
    throw new Error('Unexpected SDK request');
  });
  const get = spyOn(client.rest, 'get').mockImplementation(async (route) => {
    calls.push(route);
    switch (route) {
      case '/users/@me/guilds':
        return [{ id: '100', name: 'Quiet guild', permissions: VIEW, owner: false }];
      case '/guilds/100':
        return {
          id: '100', name: 'Quiet guild', owner_id: '901',
          roles: [{ id: '100', name: '@everyone', permissions: VIEW }],
        };
      case '/guilds/100/members/900':
        if (denySelf) throw Object.assign(new Error('Forbidden'), { status: 403 });
        return { user: { id: '900', username: 'fixture', bot: true }, roles: [], joined_at: '2026-01-01T00:00:00Z' };
      case '/guilds/100/channels':
        return [
          rawChannel('200'),
          { ...rawChannel('201'), permission_overwrites: [{ id: '100', type: 0, deny: VIEW, allow: '0' }] },
          rawChannel('202', ChannelType.GuildCategory),
        ];
      case '/guilds/100/threads/active':
        return {
          threads: [
            rawChannel('300', ChannelType.PublicThread),
            rawChannel('301', ChannelType.PrivateThread),
            rawChannel('302', ChannelType.PrivateThread),
            rawChannel('303', ChannelType.PublicThread, '201'),
          ],
          members: [{ id: '301', user_id: '900', join_timestamp: '2026-01-01T00:00:00Z', flags: 1 }],
        };
      case '/channels/400':
        return { id: '400', type: ChannelType.DM };
      default:
        throw new Error(`Unexpected metadata route ${route}`);
    }
  });
  return { client, calls, network, get };
}

test('SDK adapter checks fresh bot permissions and active-thread access, without history or rosters', async () => {
  const { client, calls, network, get } = sdkFixture();
  try {
    const result = await loadDiscordChannels('fixture', discordChannelSource(client));
    expect(result.channels.map(({ id }) => id)).toEqual(['200', '300', '301']);
    expect(calls).toEqual([
      '/users/@me/guilds', '/guilds/100', '/guilds/100/members/900',
      '/guilds/100/channels', '/guilds/100/threads/active',
    ]);
    expect(get.mock.calls[0]?.[1]).toMatchObject({ query: new URLSearchParams({ limit: '20' }) });
    expect(get.mock.calls[1]?.[1]).toMatchObject({ query: new URLSearchParams({ with_counts: 'false' }) });
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('201');
    expect(JSON.stringify(result)).not.toContain('302');
    expect(JSON.stringify(result)).not.toContain('303');
  } finally {
    await client.destroy();
    get.mockRestore();
    network.mockRestore();
  }
});

test('SDK adapter omits a guild when its own permission context is denied', async () => {
  const { client, calls, network, get } = sdkFixture(true);
  try {
    const result = await loadDiscordChannels('fixture', discordChannelSource(client));
    expect(result.channels).toEqual([]);
    expect(result.capability).toMatchObject({ supported: true, complete: false, source: 'mixed' });
    expect(result.capability.reason).toContain('guilds or their channel permissions could not be accessed');
    expect(calls).toEqual(['/users/@me/guilds', '/guilds/100', '/guilds/100/members/900']);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await client.destroy();
    get.mockRestore();
    network.mockRestore();
  }
});

test('discovery rejects a removed or replaced account cursor without contacting the replacement', async () => {
  const account = 'fixture-lifecycle';
  const original = sdkFixture();
  const replacement = sdkFixture(true);
  const originalReady = spyOn(original.client, 'isReady').mockReturnValue(true);
  const replacementReady = spyOn(replacement.client, 'isReady').mockReturnValue(true);
  const writes: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
  const call = async (args: Record<string, unknown>): Promise<{ result?: ChannelList; error?: string }> => {
    await handleCall({ op: 'call', id: 'lifecycle', action: 'listChannels', args: { account, ...args } });
    return JSON.parse(writes.at(-1) ?? '{}');
  };
  accounts.set(account, { cfg: { id: account, token: 'original-fixture' }, client: original.client });
  try {
    const first = await call({ limit: 1 });
    const cursor = first.result?.next_cursor;
    expect(cursor).toBeString();
    const before = [...original.calls];
    accounts.delete(account);
    expect((await call({ cursor })).error).toContain('Unknown Discord account');
    accounts.set(account, { cfg: { id: account, token: 'replacement-fixture' }, client: replacement.client });
    expect((await call({ cursor })).error).toContain('Invalid or expired channel cursor');
    expect(replacement.calls).toEqual([]);
    expect(original.calls).toEqual(before);
    expect((await call({})).result?.channels).toEqual([]);
    expect(replacement.calls).toHaveLength(3);
    expect(original.network).not.toHaveBeenCalled();
    expect(replacement.network).not.toHaveBeenCalled();
  } finally {
    accounts.delete(account);
    output.mockRestore();
    originalReady.mockRestore();
    replacementReady.mockRestore();
    for (const fixture of [original, replacement]) {
      await fixture.client.destroy();
      fixture.get.mockRestore();
      fixture.network.mockRestore();
    }
  }
});

test('train action returns metadata and reuses a cursor without requests or opening cached DMs', async () => {
  const { client, calls, network, get } = sdkFixture();
  const ready = spyOn(client, 'isReady').mockReturnValue(true);
  const messages: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    messages.push(String(chunk));
    return true;
  });
  accounts.set('fixture-discovery', { cfg: { id: 'fixture-discovery', token: 'unused-fixture' }, client });
  try {
    await client.channels.fetch('400');
    calls.length = 0;
    await handleCall({ op: 'call', id: 'first', action: 'listChannels', args: { account: 'fixture-discovery', limit: 1 } });
    const first: unknown = JSON.parse(messages[0] ?? '{}');
    if (typeof first !== 'object' || first === null || !('result' in first)) throw new Error('Missing response');
    const result = first.result;
    if (typeof result !== 'object' || result === null || !('next_cursor' in result)) throw new Error('Missing cursor');
    const cursor = result.next_cursor;
    expect(first).toMatchObject({
      op: 'response', id: 'first',
      result: {
        channels: [{ id: '200', line: 'metro://discord-bot/fixture-discovery/200', kind: 'channel', name: 'Quiet 200' }],
        capability: { complete: false, source: 'mixed' }, next_cursor: expect.any(String),
      },
    });
    const before = [...calls];
    await handleCall({
      op: 'call', id: 'last', action: 'listChannels',
      args: { account: 'fixture-discovery', cursor },
    });
    expect(JSON.parse(messages[1] ?? '{}')).toMatchObject({
      op: 'response', id: 'last',
      result: {
        channels: [
          { id: '300', kind: 'thread' }, { id: '301', kind: 'thread' }, { id: '400', kind: 'direct' },
        ],
        capability: { complete: false, source: 'mixed' },
      },
    });
    expect(calls).toEqual(before);
    expect(calls.some((route) => route.includes('/channels/400'))).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally {
    accounts.delete('fixture-discovery');
    output.mockRestore();
    ready.mockRestore();
    await client.destroy();
    get.mockRestore();
    network.mockRestore();
  }
});
