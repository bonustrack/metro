import type { SavedAttachment } from '@metro-labs/mcp/stations/attachments';
import { lineOf } from './accounts.js';
import { mintId, SELF_URI } from './wire.js';
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
    payload: {
      account: m.accountId,
      message_id: m.messageId,
      ...(m.media ? { attachments: [attachmentView(m.media)] } : {}),
    },
  };
}

function mediaEvent(
  m: InboundMessage,
  text: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: 'inbound',
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'whatsapp',
    line: lineOf(m.accountId, m.chatJid),
    from: SELF_URI,
    text,
    payload: { account: m.accountId, ...payload },
  };
}

export function attachmentSavedEnvelope(
  m: InboundMessage,
  sourceId: string,
  ref: WAMediaRef,
  saved: SavedAttachment,
  index: number,
): Record<string, unknown> {
  return mediaEvent(m, `📎 saved: ${saved.path}`, {
    contentType: 'attachmentSaved',
    attachmentFor: sourceId,
    index,
    kind: ref.kind,
    attachmentPath: saved.path,
    localPath: saved.path,
    mime: saved.mime,
    name: saved.name,
  });
}

export function attachmentFailedEnvelope(
  m: InboundMessage,
  sourceId: string,
  ref: WAMediaRef,
  index: number,
  reason: string,
): Record<string, unknown> {
  return mediaEvent(m, `📎 not fetched: ${reason}`, {
    contentType: 'attachmentFailed',
    attachmentFor: sourceId,
    index,
    kind: ref.kind,
    name: ref.name,
    mime: ref.mime,
    reason,
  });
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
