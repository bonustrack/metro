import type { Chat, Message, Peer, User } from '@mtcute/bun';
import type { SavedAttachment } from '@metro-labs/mcp/stations/attachments';
import { lineOf } from './accounts.js';
import { mintId } from './wire.js';

const isUser = (peer: Peer): peer is User => peer.type === 'user';
const isChat = (peer: Peer): peer is Chat => peer.type === 'chat';

function senderName(peer: Peer): string | undefined {
  if (isUser(peer)) return peer.username ? `@${peer.username}` : peer.firstName;
  return peer.title;
}

function chatName(peer: Peer): string | undefined {
  if (isChat(peer)) return peer.title;
  if (isUser(peer)) return peer.username ? `@${peer.username}` : peer.firstName;
  return undefined;
}

function topicOf(m: Message): number | undefined {
  if (!m.isTopicMessage) return undefined;
  const threadId = m.replyToMessage?.threadId;
  return threadId ?? undefined;
}

function mediaTag(m: Message): string | undefined {
  if (m.media === null) return undefined;
  return `[${m.media.type}]`;
}

function projectText(m: Message): string {
  const tag = mediaTag(m);
  return [m.text, tag].filter(Boolean).join(' ');
}

export function isOwnEcho(m: Message): boolean {
  if (m.isOutgoing) return true;
  const { sender } = m;
  return isUser(sender) && sender.isSelf;
}

export function envelope(
  accountId: string,
  m: Message,
): Record<string, unknown> {
  const topicId = topicOf(m);
  const line = lineOf(accountId, m.chat.id, topicId);
  const isPrivate = isUser(m.chat);
  return {
    kind: 'inbound',
    id: mintId(),
    ts: m.date.toISOString(),
    station: 'telegram-user',
    line,
    line_name: chatName(m.chat),
    from: `metro://telegram-user/${accountId}/user/${m.sender.id}`,
    from_name: senderName(m.sender),
    message_id: String(m.id),
    text: projectText(m),
    is_private: isPrivate,
    has_media: m.media !== null,
    payload: { account: accountId, message_id: String(m.id) },
  };
}

export function attachmentSavedEnvelope(
  accountId: string,
  line: string,
  sourceEnvId: string,
  saved: SavedAttachment,
  index = 0,
): Record<string, unknown> {
  return {
    kind: 'inbound',
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'telegram-user',
    line,
    from: `metro://telegram-user/${accountId}/self`,
    text: `📎 saved: ${saved.path}`,
    payload: {
      account: accountId,
      contentType: 'attachmentSaved',
      attachmentFor: sourceEnvId,
      index,
      attachmentPath: saved.path,
      localPath: saved.path,
      mime: saved.mime,
      name: saved.name,
    },
  };
}

export interface ReactionInput {
  accountId: string;
  chatId: number;
  messageId: number;
  emoji: string;
  senderId: number;
  date: Date;
  isPrivate: boolean;
  senderName?: string;
}

export function reactionEnvelope(r: ReactionInput): Record<string, unknown> {
  return {
    kind: 'react',
    id: mintId(),
    ts: r.date.toISOString(),
    station: 'telegram-user',
    line: lineOf(r.accountId, r.chatId),
    from: `metro://telegram-user/${r.accountId}/user/${r.senderId}`,
    from_name: r.senderName,
    message_id: String(r.messageId),
    emoji: r.emoji,
    event: { type: 'react', emoji: r.emoji, targetId: String(r.messageId) },
    is_private: r.isPrivate,
  };
}
