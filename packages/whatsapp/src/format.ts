import { lineOf } from './accounts.js';
import { mintId } from '@metro-labs/core/stations/station-runtime';
import type { WAMediaRef } from './media.js';

export interface InboundMessage {
  accountId: string;
  chatJid: string;
  senderJid: string;
  messageId: string;
  text: string;
  date: Date;
  isPrivate: boolean;
  pushName?: string;
  media?: WAMediaRef;
  replyTo?: string;
  mentionsSelf?: boolean;
  replyToSelf?: boolean;
}

export interface ReactionInput {
  accountId: string;
  chatJid: string;
  senderJid: string;
  messageId: string;
  emoji: string;
  date: Date;
  isPrivate: boolean;
  pushName?: string;
  removed?: boolean;
}

function attachmentView(ref: WAMediaRef): Record<string, unknown> {
  return {
    kind: ref.kind,
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.mime ? { mime: ref.mime } : {}),
    ...(ref.bytes === undefined ? {} : { size: ref.bytes }),
  };
}

export function envelope(m: InboundMessage): Record<string, unknown> {
  return {
    id: mintId(),
    ts: m.date.toISOString(),
    station: 'whatsapp',
    line: lineOf(m.accountId, m.chatJid),
    from: `metro://whatsapp/${m.accountId}/user/${m.senderJid}`,
    ...(m.pushName ? { from_name: m.pushName, from_display_name: m.pushName } : {}),
    message_id: m.messageId,
    text: m.text,
    is_private: m.isPrivate,
    ...(m.replyTo === undefined ? {} : { reply_to: m.replyTo, event: { type: 'reply', replyTo: m.replyTo } }),
    ...(m.mentionsSelf === true ? { mentions_self: true } : {}),
    ...(m.replyToSelf === true ? { reply_to_self: true } : {}),
    payload: {
      account: m.accountId,
      message_id: m.messageId,
      ...(m.media ? { attachments: [attachmentView(m.media)] } : {}),
    },
  };
}

export function reactionEnvelope(r: ReactionInput): Record<string, unknown> {
  return {
    id: mintId(),
    ts: r.date.toISOString(),
    station: 'whatsapp',
    line: lineOf(r.accountId, r.chatJid),
    from: `metro://whatsapp/${r.accountId}/user/${r.senderJid}`,
    ...(r.pushName ? { from_name: r.pushName } : {}),
    message_id: r.messageId,
    emoji: r.emoji,
    event: { type: 'react', emoji: r.emoji, targetId: r.messageId },
    is_private: r.isPrivate,
    payload: {
      account: r.accountId,
      message_id: r.messageId,
      removed: r.removed === true,
    },
  };
}
