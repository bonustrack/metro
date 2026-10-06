import { describe, expect, test } from 'bun:test';
import { ChannelDirectory, DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { loadDiscordChannels, listChannels } from '../src/channels.js';
import type {
  DiscordChannelMetadata,
  DiscordChannelSource,
  DiscordGuildSource,
} from '../src/channel-source.js';
import { discordBotStation } from '../src/station.js';

const view = new PermissionsBitField(PermissionFlagsBits.ViewChannel);
const denied = new PermissionsBitField(PermissionFlagsBits.ReadMessageHistory);
const managed = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads]);

function channel(id: string, extra: Partial<DiscordChannelMetadata> = {}): DiscordChannelMetadata {
  return { id, name: `Quiet ${id}`, type: ChannelType.GuildText, permissions: view, ...extra };
}

function fixture(
  channels: DiscordChannelMetadata[] = [],
  threads: DiscordChannelMetadata[] = [],
  directs: DiscordChannelMetadata[] = [],
): { source: DiscordChannelSource; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    source: {
      guilds: async (after, limit) => {
        calls.push(`guilds:${after ?? ''}:${limit}`);
        return ['guild'];
      },
      guild: async (id): Promise<DiscordGuildSource> => {
        calls.push(`guild:${id}`);
        return {
          channels: async () => { calls.push('channels'); return channels; },
          threads: async () => { calls.push('threads'); return threads; },
        };
      },
      directs: () => directs,
    },
  };
}

function forbidden(): Error & { status: number } {
  return Object.assign(new Error('Forbidden'), { status: 403 });
}

describe('Discord channel discovery', () => {
  test('finds quiet channels and cached DMs without messages, profiles or contacts', async () => {
    const { source, calls } = fixture(
      [channel('quiet'), channel('forum', { type: ChannelType.GuildForum })],
      [channel('thread', { type: ChannelType.PublicThread })],
      [channel('dm', { type: ChannelType.DM, name: undefined, permissions: undefined })],
    );
    const result = await loadDiscordChannels('bot', source);
    expect(result.channels).toEqual([
      { id: 'dm', line: 'metro://discord-bot/bot/dm', kind: 'direct' },
      { id: 'quiet', line: 'metro://discord-bot/bot/quiet', kind: 'channel', name: 'Quiet quiet' },
      { id: 'forum', line: 'metro://discord-bot/bot/forum', kind: 'channel', name: 'Quiet forum' },
      { id: 'thread', line: 'metro://discord-bot/bot/thread', kind: 'thread', name: 'Quiet thread' },
    ]);
    expect(calls).toEqual(['guilds::20', 'guild:guild', 'channels', 'threads']);
    expect(result.capability).toMatchObject({ supported: true, complete: false, source: 'mixed' });
    expect(result.capability.reason).toContain('Archived and inaccessible threads');
    expect(result.capability.reason).toContain('no complete bot DM directory');
  });

  test('requires ViewChannel only and rejects unauthorized private threads and categories', async () => {
    const { source } = fixture([
      channel('view-only'),
      channel('forbidden', { permissions: denied }),
      channel('unknown-permissions', { permissions: null }),
      channel('category', { type: ChannelType.GuildCategory }),
    ], [
      channel('public', { type: ChannelType.PublicThread }),
      channel('private-denied', { type: ChannelType.PrivateThread }),
      channel('private-joined', { type: ChannelType.PrivateThread, joined: true }),
      channel('private-managed', { type: ChannelType.PrivateThread, permissions: managed }),
      channel('joined-forbidden-parent', { type: ChannelType.PrivateThread, joined: true, permissions: denied }),
      channel('archived', { type: ChannelType.PublicThread, archived: true }),
    ]);
    const result = await loadDiscordChannels('bot', source);
    expect(result.channels.map(({ id }) => id)).toEqual([
      'view-only', 'public', 'private-joined', 'private-managed',
    ]);
    expect(JSON.stringify(result)).not.toContain('forbidden');
    expect(JSON.stringify(result)).not.toContain('private-denied');
  });

  test('deduplicates, searches and pages a stable snapshot without another SDK load', async () => {
    const { source, calls } = fixture([
      channel('z', { name: 'Planning' }), channel('a', { name: 'PLANNING' }), channel('a'),
    ], [], [channel('group', { type: ChannelType.GroupDM })]);
    const directory = new ChannelDirectory();
    const load = () => loadDiscordChannels('bot', source);
    const first = await directory.list('bot', { query: 'plan', limit: 1 }, load);
    expect(first.channels.map(({ id }) => id)).toEqual(['a']);
    expect(first.next_cursor).toBeString();
    const before = [...calls];
    const last = await directory.list('bot', { query: 'PLAN', cursor: first.next_cursor }, load);
    expect(last.channels.map(({ id }) => id)).toEqual(['z']);
    expect(last.next_cursor).toBeUndefined();
    expect(last.capability.complete).toBe(false);
    expect(calls).toEqual(before);
    expect((await directory.list('bot', { query: '/BOT/GROUP' }, load)).channels).toEqual([
      { id: 'group', line: 'metro://discord-bot/bot/group', name: 'Quiet group', kind: 'group' },
    ]);
    expect((await directory.list('bot', { query: 'z' }, load)).channels.map(({ id }) => id)).toEqual(['z']);
    await expect(directory.list('other', { query: 'plan', cursor: first.next_cursor }, load)).rejects.toThrow('cursor');
    await expect(directory.list('bot', { query: 'other', cursor: first.next_cursor }, load)).rejects.toThrow('cursor');
  });

  test('bounds metadata scanning even when entries are duplicate or forbidden', async () => {
    const { source, calls } = fixture();
    let visited = 0;
    source.guild = async () => ({
      channels: async () => (function* () {
        for (let i = 0; i < DIRECTORY_LIMIT * 2; i++) {
          visited++;
          yield channel('forbidden', { permissions: denied });
        }
      })(),
      threads: async () => { calls.push('unexpected-threads'); return []; },
    });
    const result = await loadDiscordChannels('bot', source);
    expect(visited).toBe(DIRECTORY_LIMIT + 1);
    expect(result.channels).toEqual([]);
    expect(result.capability.reason).toContain('metadata scan limit');
    expect(calls).not.toContain('unexpected-threads');
  });

  test('bounds retained entries and keeps the last local page honestly partial', async () => {
    const { source } = fixture(Array.from({ length: DIRECTORY_LIMIT + 1 }, (_, i) => channel(String(i))));
    const snapshot = await loadDiscordChannels('bot', source);
    expect(snapshot.channels).toHaveLength(DIRECTORY_LIMIT);
    expect(snapshot.capability.reason).toContain('metadata scan limit');
    const directory = new ChannelDirectory();
    const result = await directory.list('bot', { query: 'does-not-exist' }, async () => snapshot);
    expect(result.channels).toEqual([]);
    expect(result.next_cursor).toBeUndefined();
    expect(result.capability.complete).toBe(false);
  });

  test('reports denied guilds and threads without leaking inaccessible metadata', async () => {
    const { source } = fixture();
    source.guilds = async () => ['denied', 'visible'];
    source.guild = async (id) => {
      if (id === 'denied') throw forbidden();
      return { channels: async () => [channel('visible')], threads: async () => { throw forbidden(); } };
    };
    const result = await loadDiscordChannels('bot', source);
    expect(result.channels.map(({ id }) => id)).toEqual(['visible']);
    expect(result.capability.reason).toContain('Some guilds');
    expect(result.capability.reason).toContain('Some active threads');
    expect(result.capability.complete).toBe(false);
  });

  test('retains cached DMs on a denied guild directory but propagates other failures', async () => {
    const { source } = fixture([], [], [channel('dm', { type: ChannelType.DM })]);
    source.guilds = async () => { throw forbidden(); };
    const partial = await loadDiscordChannels('bot', source);
    expect(partial.channels.map(({ id }) => id)).toEqual(['dm']);
    expect(partial.capability.source).toBe('local');
    expect(partial.capability.reason).toContain('only cached DMs');
    source.guilds = async () => { throw new Error('provider unavailable'); };
    await expect(loadDiscordChannels('bot', source)).rejects.toThrow('provider unavailable');
  });

  test('preserves remote channels when a later guild page is denied', async () => {
    const { source } = fixture();
    source.guilds = async (after) => {
      if (after !== undefined) throw forbidden();
      return Array.from({ length: 20 }, (_, i) => String(i));
    };
    source.guild = async (id) => ({ channels: async () => [channel(id)], threads: async () => [] });
    const result = await loadDiscordChannels('bot', source);
    expect(result.channels).toHaveLength(20);
    expect(result.capability.source).toBe('mixed');
    expect(result.capability.reason).toContain('pagination became inaccessible');
    expect(result.capability.reason).not.toContain('only cached DMs');
  });

  test('pages guilds, deduplicates guild IDs and detects a repeated page', async () => {
    const { source } = fixture();
    const pages: Array<[string | undefined, number]> = [];
    let fetched = 0;
    source.guild = async () => {
      fetched++;
      return { channels: async () => [], threads: async () => [] };
    };
    source.guilds = async (after, limit) => {
      pages.push([after, limit]);
      return Array.from({ length: 20 }, (_, i) => String(i));
    };
    const result = await loadDiscordChannels('bot', source);
    expect(pages).toEqual([[undefined, 20], ['19', 20]]);
    expect(fetched).toBe(20);
    expect(result.capability.reason).toContain('pagination did not advance');
  });

  test('bounds requests across many empty guilds and reports the missing remainder', async () => {
    const { source } = fixture();
    let requests = 0;
    source.guilds = async (after, limit) => {
      requests++;
      const start = after === undefined ? 0 : Number(after) + 1;
      return Array.from({ length: limit }, (_, i) => String(start + i));
    };
    source.guild = async () => {
      requests += 2;
      return {
        channels: async () => { requests++; return []; },
        threads: async () => { requests++; return []; },
      };
    };
    const result = await loadDiscordChannels('bot', source);
    expect(requests).toBe(100);
    expect(result.channels).toEqual([]);
    expect(result.capability.complete).toBe(false);
    expect(result.capability.reason).toContain('request or time budget reached');
  });

  test('stops starting requests after the time budget without discarding completed metadata', async () => {
    const { source, calls } = fixture();
    let now = 0;
    source.guild = async () => ({
      channels: async () => {
        now = 30_000;
        return [channel('slow-but-visible')];
      },
      threads: async () => { calls.push('unexpected-threads'); return []; },
    });
    const result = await loadDiscordChannels('bot', source, () => now);
    expect(result.channels.map(({ id }) => id)).toEqual(['slow-but-visible']);
    expect(result.capability.reason).toContain('request or time budget reached');
    expect(calls).not.toContain('unexpected-threads');
  });

  test('advertises discovery and requires an explicit known account before loading', async () => {
    expect(discordBotStation.discoversChannels).toBe(true);
    await expect(listChannels('missing', {})).rejects.toThrow('account is required');
    await expect(listChannels('blank', { account: ' ' })).rejects.toThrow('account is required');
    await expect(listChannels('unknown', { account: 'not-connected' })).rejects.toThrow('Unknown Discord account');
  });
});
