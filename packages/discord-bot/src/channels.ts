import {
  ChannelDirectory,
  DIRECTORY_LIMIT,
  type ChannelEntry,
  type ChannelSnapshot,
} from '@metro-labs/core/stations/channel-directory';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { accounts, lineOf, type Account } from './accounts.js';
import {
  discordChannelSource,
  type DiscordChannelMetadata,
  type DiscordChannelSource,
  type DiscordGuildSource,
} from './channel-source.js';

const directories = new WeakMap<Account, ChannelDirectory>();
const GUILD_PAGE = 20;
const REQUEST_LIMIT = 100;
const SCAN_MS = 30_000;
const LIMIT_REASON = `Discovery stopped at the ${DIRECTORY_LIMIT} metadata scan limit; results are partial.`;
const THREAD_REASON = 'Archived and inaccessible threads are omitted; only accessible active threads are listed.';
const DM_REASON = 'DMs are limited to channels already cached by this bot; Discord has no complete bot DM directory.';

function kindOf(type: ChannelType): ChannelEntry['kind'] | undefined {
  switch (type) {
    case ChannelType.DM: return 'direct';
    case ChannelType.GroupDM: return 'group';
    case ChannelType.AnnouncementThread:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread: return 'thread';
    case ChannelType.GuildCategory: return undefined;
    default: return 'channel';
  }
}

function visible(channel: DiscordChannelMetadata): boolean {
  if (!channel.permissions?.has(PermissionFlagsBits.ViewChannel)) return false;
  return channel.type !== ChannelType.PrivateThread || channel.joined === true ||
    channel.permissions.has(PermissionFlagsBits.ManageThreads);
}

function inaccessible(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error &&
    (error.status === 403 || error.status === 404);
}

class Snapshot {
  readonly channels = new Map<string, ChannelEntry>();
  readonly reasons = new Set([THREAD_REASON, DM_REASON]);
  private scanned = 0;
  private requests = 0;
  private readonly started: number;
  remote = false;

  constructor(private readonly account: string, private readonly now: () => number) {
    this.started = now();
  }

  canFetch(cost = 1): boolean {
    if (this.requests + cost > REQUEST_LIMIT || this.now() - this.started >= SCAN_MS) {
      this.reasons.add('Discovery request or time budget reached; additional guilds or threads may be missing.');
      return false;
    }
    this.requests += cost;
    return true;
  }

  collect(channels: Iterable<DiscordChannelMetadata>, direct = false): boolean {
    for (const channel of channels) {
      if (++this.scanned > DIRECTORY_LIMIT) {
        this.reasons.add(LIMIT_REASON);
        return false;
      }
      this.add(channel, direct);
    }
    return true;
  }

  private add(channel: DiscordChannelMetadata, direct: boolean): void {
    const kind = kindOf(channel.type);
    if (!kind || channel.archived) return;
    if (direct ? kind !== 'direct' && kind !== 'group' : !visible(channel)) return;
    const line = lineOf(this.account, channel.id);
    if (!this.channels.has(line)) {
      this.channels.set(line, {
        id: channel.id,
        line,
        kind,
        ...(channel.name ? { name: channel.name } : {}),
      });
    }
  }

  result(): ChannelSnapshot {
    return {
      channels: [...this.channels.values()],
      capability: {
        supported: true,
        complete: false,
        source: this.remote ? 'mixed' : 'local',
        reason: [...this.reasons].join(' '),
      },
    };
  }
}

async function collectGuild(guild: DiscordGuildSource, snapshot: Snapshot): Promise<boolean> {
  if (!snapshot.canFetch() || !snapshot.collect(await guild.channels())) return false;
  if (!snapshot.canFetch()) return false;
  try {
    return snapshot.collect(await guild.threads());
  } catch (error) {
    if (!inaccessible(error)) throw error;
    snapshot.reasons.add('Some active threads could not be accessed and were omitted.');
    return true;
  }
}

async function visitGuild(id: string, source: DiscordChannelSource, snapshot: Snapshot): Promise<boolean> {
  try {
    return await collectGuild(await source.guild(id), snapshot);
  } catch (error) {
    if (!inaccessible(error)) throw error;
    snapshot.reasons.add('Some guilds or their channel permissions could not be accessed and were omitted.');
    return true;
  }
}

async function collectGuilds(source: DiscordChannelSource, snapshot: Snapshot): Promise<void> {
  const visited = new Set<string>();
  let after: string | undefined;
  for (;;) {
    if (!snapshot.canFetch()) return;
    const page = await source.guilds(after, GUILD_PAGE);
    snapshot.remote = true;
    const previousSize = visited.size;
    for (const id of page) {
      if (visited.has(id)) continue;
      if (!snapshot.canFetch(2)) return;
      visited.add(id);
      if (!await visitGuild(id, source, snapshot)) return;
    }
    if (page.length < GUILD_PAGE) return;
    if (visited.size === previousSize || page.at(-1) === after) {
      snapshot.reasons.add('Discord guild pagination did not advance; results are partial.');
      return;
    }
    after = page.at(-1);
  }
}

export async function loadDiscordChannels(
  account: string,
  source: DiscordChannelSource,
  now: () => number = Date.now,
): Promise<ChannelSnapshot> {
  const snapshot = new Snapshot(account, now);
  if (snapshot.collect(source.directs(), true)) {
    try {
      await collectGuilds(source, snapshot);
    } catch (error) {
      if (!inaccessible(error)) throw error;
      snapshot.reasons.add(snapshot.remote
        ? 'Discord guild pagination became inaccessible; channels from remaining guilds are omitted.'
        : 'The bot guild directory could not be accessed; only cached DMs are listed.');
    }
  }
  return snapshot.result();
}

export async function listChannels(id: string, args: Record<string, unknown>): Promise<void> {
  const { account } = args;
  if (typeof account !== 'string' || !account.trim())
    throw new TrainError('bad_request', 'account is required to list Discord channels');
  const bot = accounts.get(account);
  if (!bot) throw new TrainError('bad_request', `Unknown Discord account '${account}'`);
  const directory = directories.get(bot) ?? new ChannelDirectory();
  directories.set(bot, directory);
  const result = await directory.list(account, args, () => {
    if (!bot.client.isReady()) throw new TrainError('unavailable', 'Discord bot is not ready');
    return loadDiscordChannels(account, discordChannelSource(bot.client));
  });
  respond(id, { result });
}
