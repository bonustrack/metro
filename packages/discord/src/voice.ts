import { errMsg } from '@metro-labs/metro/log';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { accountFor, accounts } from './accounts.js';
import { respond } from './wire.js';
import {
  startTranscription,
  stopTranscription,
  setTranscription,
} from './voice-transcribe.js';

const DEFAULT_USERNAME = 'bonustrack_';

function clientFor(account?: string): { accountId: string; client: Client } {
  const accountId = accountFor({ account });
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  return { accountId, client: acct.client };
}

function voiceStateMatches(
  vs: { id: string; member?: { user: { username?: string } } | null },
  opts: { userId?: string; username?: string },
): boolean {
  if (opts.userId && vs.id === opts.userId) return true;
  return Boolean(
    opts.username &&
      vs.member?.user.username?.toLowerCase() === opts.username.toLowerCase(),
  );
}

function findUserVoiceChannel(
  client: Client,
  opts: { userId?: string; username?: string },
): VoiceBasedChannel | null {
  for (const guild of client.guilds.cache.values()) {
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId) continue;
      if (voiceStateMatches(vs, opts)) return vs.channel ?? null;
    }
  }
  return null;
}

async function resolveTarget(
  client: Client,
  args: {
    guildId?: string;
    channelId?: string;
    userId?: string;
    username?: string;
  },
): Promise<VoiceBasedChannel> {
  if (args.channelId) {
    const ch = await client.channels.fetch(args.channelId);
    if (!ch || !('guild' in ch) || !ch.isVoiceBased()) {
      throw new Error(`channel ${args.channelId} is not a voice channel`);
    }
    return ch;
  }
  const ch = findUserVoiceChannel(client, {
    userId: args.userId,
    username: args.userId ? undefined : (args.username ?? DEFAULT_USERNAME),
  });
  if (!ch) {
    const who = args.userId ?? args.username ?? DEFAULT_USERNAME;
    throw new Error(
      `could not find a voice channel for '${who}' — ` +
        'is the user connected to voice in a guild the bot shares, and is the ' +
        'GuildVoiceStates intent enabled? (full daemon restart needed after intent change)',
    );
  }
  return ch;
}

export async function joinVoice(
  id: string,
  rawArgs: Record<string, unknown>,
): Promise<void> {
  const args = rawArgs as {
    account?: string;
    guildId?: string;
    channelId?: string;
    userId?: string;
    username?: string;
  };
  const { accountId, client } = clientFor(args.account);
  if (!client.isReady()) {
    respond(id, { error: `gateway not ready for '${accountId}'` });
    return;
  }

  const channel = await resolveTarget(client, args);
  const guild = channel.guild;

  const connection: VoiceConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw new Error(
      `voice connection failed to become Ready: ${errMsg(err)}`,
    );
  }

  try {
    startTranscription(guild.id, channel.id, accountId, client, connection);
  } catch (err) {
    process.stderr.write(
      `voice transcription arm failed: ${errMsg(err)}\n`,
    );
  }

  respond(id, {
    result: {
      ok: true,
      account: accountId,
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name,
      status: connection.state.status,
      transcribing: true,
    },
  });
}

export function voiceDebug(id: string, rawArgs: Record<string, unknown>): void {
  const args = rawArgs as { account?: string };
  const { accountId, client } = clientFor(args.account);
  const guilds = [...client.guilds.cache.values()].map((g) => {
    const voiceChannels = [...g.channels.cache.values()]
      .filter((c) => c.isVoiceBased())
      .map((c) => ({ id: c.id, name: c.name }));
    const occupants = [...g.voiceStates.cache.values()]
      .filter((vs) => vs.channelId)
      .map((vs) => ({
        channelId: vs.channelId,
        channelName: vs.channel?.name ?? null,
        userId: vs.id,
        username: vs.member?.user.username ?? null,
      }));
    return { id: g.id, name: g.name, voiceChannels, occupants };
  });
  respond(id, {
    result: { ok: true, account: accountId, ready: client.isReady(), guilds },
  });
}

export function leaveVoice(id: string, rawArgs: Record<string, unknown>): void {
  const args = rawArgs as { account?: string; guildId?: string };
  const { accountId, client } = clientFor(args.account);

  const guildIds = args.guildId
    ? [args.guildId]
    : [...client.guilds.cache.keys()];
  const left: string[] = [];
  for (const gid of guildIds) {
    const conn = getVoiceConnection(gid);
    if (conn) {
      stopTranscription(gid);
      conn.destroy();
      left.push(gid);
    }
  }
  respond(id, { result: { ok: true, account: accountId, leftGuilds: left } });
}

export function voiceTranscribe(
  id: string,
  rawArgs: Record<string, unknown>,
): void {
  const args = rawArgs as { account?: string; guildId?: string; on?: boolean };
  const { accountId, client } = clientFor(args.account);
  const on = args.on !== false;
  const guildIds = args.guildId
    ? [args.guildId]
    : [...client.guilds.cache.keys()];
  const toggled: string[] = [];
  for (const gid of guildIds) if (setTranscription(gid, on)) toggled.push(gid);
  respond(id, {
    result: { ok: true, account: accountId, on, toggledGuilds: toggled },
  });
}
