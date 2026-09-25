import type { Conversation, DecodedMessage } from '@xmtp/node-sdk';
import { lineOf } from './accounts.js';
import { selfUri } from '@metro-labs/core/stations/train-events';
import { emit, mintId, rememberSent, rememberUid } from './wire.js';
import { typedEnvelope, type EnvelopeCtx } from './emit-payloads.js';
import type { StructuredEvent } from '@metro-labs/core/events';

export function envelope(
  accountId: string,
  msg: DecodedMessage,
  conv: Conversation,
): Record<string, unknown> {
  const typeId = msg.contentType?.typeId;
  const c = msg.content;
  const line = lineOf(accountId, conv.id);
  const base = {
    id: mintId(),
    ts: msg.sentAt.toISOString(),
    station: 'xmtp',
    line,
    from: `metro://xmtp/${accountId}/user/${msg.senderInboxId}`,
    message_id: msg.id,
    is_private: typeof (conv as unknown as { peerInboxId?: unknown }).peerInboxId === 'function',
  };
  rememberUid(base.id, msg.id);
  if (typeof c === 'string')
    return { ...base, text: c, payload: { contentType: typeId } };
  if (c && typeof c === 'object') {
    const ctx: EnvelopeCtx = {
      accountId,
      msgId: msg.id,
      line,
      baseId: base.id,
    };
    const out = typedEnvelope(base, typeId, c, ctx);
    if (out) return out;
  }
  return {
    ...base,
    text: `[${typeId ?? 'unknown'} payload]`,
    payload: { contentType: typeId },
  };
}

export function emitOutbound(
  accountId: string,
  line: string,
  messageId: string,
  text: string,
  event?: StructuredEvent,
): void {
  const uid = mintId();
  rememberUid(uid, messageId);
  rememberSent(messageId);
  emit({
    id: uid,
    ts: new Date().toISOString(),
    station: 'xmtp',
    line,
    from: selfUri('xmtp', accountId),
    to: line,
    message_id: messageId,
    text,
    ...(event ? { event } : {}),
    payload: { account: accountId },
  });
}
