import { lineOf } from './accounts.js';
import { mintId } from './wire.js';

export interface InboundMessage {
  accountId: string;
  chatJid: string;
  senderJid: string;
  messageId: string;
  text: string;
  date: Date;
  isPrivate: boolean;
  pushName?: string;
  hasMedia: boolean;
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

export function envelope(m: InboundMessage): Record<string, unknown> {
  return {
    kind: 'inbound',
    id: mintId(),
    ts: m.date.toISOString(),
    station: 'whatsapp',
    line: lineOf(m.accountId, m.chatJid),
    from: `metro://whatsapp/${m.accountId}/user/${m.senderJid}`,
    ...(m.pushName ? { from_name: m.pushName, from_display_name: m.pushName } : {}),
    message_id: m.messageId,
    text: m.text,
    is_private: m.isPrivate,
    has_media: m.hasMedia,
    payload: {
      account: m.accountId,
      message_id: m.messageId,
    },
  };
}

export function reactionEnvelope(r: ReactionInput): Record<string, unknown> {
  return {
    kind: 'react',
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
