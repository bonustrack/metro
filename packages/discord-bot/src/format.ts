import { MessageFlags, type Message, type MessageReaction, type User } from 'discord.js';
import { reportAttachment, selfUri } from '@metro-labs/core/stations/train-events';
import { accounts, lineOf } from './accounts.js';
import { emit, mintId } from './wire.js';
import { saveDiscordAttachment } from './attachments.js';

const AV_TAG: Record<string, string> = { audio: 'audio', video: 'video' };

function tagFor(att: {
  contentType?: string | null;
  name?: string | null;
  voice?: boolean;
}): string {
  const type = (att.contentType ?? '').split('/')[0] ?? '';
  if (type === 'image') return '[image]';
  if (att.voice && type === 'audio') return '[voice]';
  const kind = AV_TAG[type] ?? 'file';
  return `[${kind}: ${att.name ?? kind}]`;
}

function addressing(accountId: string, m: Message): { mentions_self: boolean; reply_to_self: boolean } {
  const me = accounts.get(accountId)?.client.user ?? null;
  if (me === null) return { mentions_self: false, reply_to_self: false };
  return {
    mentions_self: m.mentions.has(me, { ignoreRepliedUser: true, ignoreEveryone: true }),
    reply_to_self: m.mentions.repliedUser?.id === me.id,
  };
}

const senderOf = (m: Message): Record<string, string | undefined> => ({
  from_name: m.author.username,
  from_display_name: m.member?.displayName ?? m.author.globalName ?? undefined,
});

export function messageEnvelope(
  accountId: string,
  m: Message,
): Record<string, unknown> | null {
  if (m.author.bot) return null;
  const voice = m.flags.has(MessageFlags.IsVoiceMessage);
  const tags = m.attachments.map((a) =>
    tagFor({ contentType: a.contentType, name: a.name, voice }),
  );
  const stickerTags = m.stickers.map((s) => `[sticker: ${s.name}]`);
  const text = [m.content.trim(), ...tags, ...stickerTags]
    .filter(Boolean)
    .join(' ');
  const line = lineOf(accountId, m.channelId);
  const envId = mintId();
  const attachments = [...m.attachments.values()].map((a) => ({
    id: a.id,
    url: a.url,
    proxyURL: a.proxyURL,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
  }));
  attachments.forEach((a, i) => {
    reportAttachment(
      saveDiscordAttachment({ url: a.url, name: a.name, contentType: a.contentType }, m.id, i),
      { station: 'discord-bot', account: accountId, line, forId: envId, index: i },
      { failed: { name: a.name, mime: a.contentType ?? undefined } },
    );
  });
  return {
    id: envId,
    ts: new Date(m.createdTimestamp).toISOString(),
    station: 'discord-bot',
    line,
    line_name: 'name' in m.channel ? m.channel.name : undefined,
    from: `metro://discord-bot/${accountId}/user/${m.author.id}`,
    ...senderOf(m),
    message_id: m.id,
    text,
    is_private: m.guildId == null,
    reply_to: m.reference?.messageId ?? undefined,
    ...addressing(accountId, m),
    ...(m.reference?.messageId
      ? { event: { type: 'reply', replyTo: m.reference.messageId } }
      : {}),
    payload: { ...(m.toJSON() as Record<string, unknown>), attachments },
  };
}

export function reactionEnvelope(
  accountId: string,
  r: MessageReaction,
  u: User,
): Record<string, unknown> | null {
  if (u.bot) return null;
  return {
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'discord-bot',
    line: lineOf(accountId, r.message.channelId),
    from: `metro://discord-bot/${accountId}/user/${u.id}`,
    from_name: u.username,
    from_display_name: u.globalName ?? undefined,
    message_id: r.message.id,
    emoji: r.emoji.name ?? r.emoji.id ?? '?',
    is_private: r.message.guildId == null,
    event: {
      type: 'react',
      emoji: r.emoji.name ?? r.emoji.id ?? '?',
      targetId: r.message.id,
    },
    payload: {
      channel_id: r.message.channelId,
      guild_id: r.message.guildId,
      emoji: r.emoji.toJSON(),
      user_id: u.id,
    },
  };
}

function outbound(
  accountId: string,
  line: string,
  messageId: string,
  extra: object,
): void {
  emit({
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'discord-bot',
    line,
    from: selfUri('discord-bot', accountId),
    to: line,
    message_id: messageId,
    ...extra,
    payload: { account: accountId },
  });
}

export function emitOutbound(
  accountId: string,
  line: string,
  messageId: string,
  text: string,
  replyTo?: string,
): void {
  outbound(accountId, line, messageId, {
    text,
    reply_to: replyTo,
    ...(replyTo ? { event: { type: 'reply', replyTo } } : {}),
  });
}
export function emitOutboundReact(
  accountId: string,
  line: string,
  messageId: string,
  emoji: string,
): void {
  outbound(accountId, line, messageId, {
    emoji,
    event: { type: 'react', emoji, targetId: messageId },
  });
}
export function emitOutboundEdit(
  accountId: string,
  line: string,
  messageId: string,
  text: string,
): void {
  outbound(accountId, line, messageId, {
    text,
    event: { type: 'edit', targetId: messageId },
  });
}
