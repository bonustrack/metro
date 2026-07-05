import type { Conversation, DecodedMessage } from '@xmtp/node-sdk';
import { lineOf, parseLine } from './accounts.js';
import { emit, mintId, rememberUid, SELF_URI } from './wire.js';
import { fcmPushToAll } from './push.js';
import { emitInbound, emitAttachmentSaved } from './emit-core.js';
import { typedEnvelope, type EnvelopeCtx } from './emit-payloads.js';
import type { StructuredEvent } from '@metro-labs/mcp/events';

export { emitInbound, emitAttachmentSaved };

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
  emit({
    kind: 'outbound',
    id: uid,
    ts: new Date().toISOString(),
    station: 'xmtp',
    line,
    from: SELF_URI,
    to: line,
    message_id: messageId,
    text,
    account: accountId,
    ...(event ? { event } : {}),
    payload: { account: accountId },
  });
  void (async (): Promise<void> => {
    const data: Record<string, string> = { line, messageId };
    {
      const p = parseLine(line);
      if (p) data.convId = p.convId.toLowerCase();
    }
    await fcmPushToAll(accountId, data);
  })().catch(() => undefined);
}
