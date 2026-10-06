import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type PermissionsBitField,
} from 'discord.js';

export interface DiscordChannelMetadata {
  id: string;
  name?: string;
  type: ChannelType;
  permissions?: Readonly<PermissionsBitField> | null;
  joined?: boolean;
  archived?: boolean | null;
}

export interface DiscordGuildSource {
  channels(): Promise<Iterable<DiscordChannelMetadata>>;
  threads(): Promise<Iterable<DiscordChannelMetadata>>;
}

export interface DiscordChannelSource {
  guilds(after: string | undefined, limit: number): Promise<string[]>;
  guild(id: string): Promise<DiscordGuildSource>;
  directs(): Iterable<DiscordChannelMetadata>;
}

function* guildMetadata(
  channels: Iterable<GuildBasedChannel | null>,
  me: GuildMember,
): Iterable<DiscordChannelMetadata> {
  for (const channel of channels) {
    if (!channel) continue;
    yield {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      permissions: channel.permissionsFor(me),
      ...(channel.isThread() ? { joined: channel.joined, archived: channel.archived } : {}),
    };
  }
}

function guildSource(guild: Guild, me: GuildMember): DiscordGuildSource {
  return {
    async channels() {
      return guildMetadata((await guild.channels.fetch()).values(), me);
    },
    async threads() {
      const result = await guild.channels.fetchActiveThreads(false);
      return guildMetadata(result.threads.values(), me);
    },
  };
}

export function discordChannelSource(client: Client): DiscordChannelSource {
  return {
    async guilds(after, limit) {
      return [...(await client.guilds.fetch({ after, limit })).keys()];
    },
    async guild(id) {
      const guild = await client.guilds.fetch({ guild: id, force: true, withCounts: false });
      const me = await guild.members.fetchMe({ force: true });
      return guildSource(guild, me);
    },
    *directs() {
      for (const channel of client.channels.cache.values()) {
        if (channel.type !== ChannelType.DM && channel.type !== ChannelType.GroupDM) continue;
        yield {
          id: channel.id,
          type: channel.type,
          ...('name' in channel && channel.name ? { name: channel.name } : {}),
        };
      }
    },
  };
}
