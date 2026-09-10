import { emit, mintId } from '@metro-labs/core/stations/station-runtime';
import { RECEIPT_ACK, RECEIPT_DECLINE, unquote } from './crypto.js';

const SELF_URI = process.env.METRO_SELF_URI ?? '';

const REACTION_OF: Record<number, string> = {
  [RECEIPT_ACK]: '👍',
  [RECEIPT_DECLINE]: '👎',
};

export const lineOf = (accountId: string, threemaId: string): string =>
  `metro://threema/${accountId}/${threemaId}`;

const userOf = (accountId: string, threemaId: string): string =>
  `metro://threema/${accountId}/user/${threemaId}`;

export interface InboundMeta {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nickname?: string;
}

function tsOf(date: string): string {
  const seconds = Number(date);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

function base(
  accountId: string,
  m: InboundMeta,
  type: string,
): Record<string, unknown> {
  return {
    kind: 'inbound',
    id: mintId(),
    ts: tsOf(m.date),
    station: 'threema',
    line: lineOf(accountId, m.from),
    line_name: m.nickname ?? m.from,
    from: userOf(accountId, m.from),
    from_name: m.nickname,
    from_display_name: m.nickname,
    is_private: true,
    payload: { from: m.from, to: m.to, nickname: m.nickname ?? null, type },
  };
}

export function textEnvelope(
  accountId: string,
  m: InboundMeta,
  raw: string,
  sentByUs: (messageId: string) => boolean,
): Record<string, unknown> {
  const { replyTo, text } = unquote(raw);
  return {
    ...base(accountId, m, 'text'),
    message_id: m.messageId,
    text,
    ...(replyTo === undefined
      ? {}
      : {
          reply_to: replyTo,
          event: { type: 'reply', replyTo },
          reply_to_self: sentByUs(replyTo),
        }),
  };
}

export function receiptEnvelope(
  accountId: string,
  m: InboundMeta,
  status: number,
  targetId: string,
): Record<string, unknown> | null {
  const emoji = REACTION_OF[status];
  if (emoji === undefined) return null;
  return {
    ...base(accountId, m, 'receipt'),
    message_id: `${m.messageId}:${targetId}`,
    emoji,
    event: { type: 'react', emoji, targetId },
  };
}

export function emitInbound(
  accountId: string,
  owner: string | undefined,
  env: Record<string, unknown>,
): void {
  const payload = {
    ...(env.payload as Record<string, unknown> | undefined),
    account: accountId,
  };
  emit({ ...env, ...(owner ? { to: owner } : {}), account: accountId, payload });
}

export function emitOutbound(
  accountId: string,
  line: string,
  messageId: string,
  text: string,
  replyTo?: string,
): void {
  emit({
    kind: 'outbound',
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'threema',
    line,
    from: SELF_URI,
    to: line,
    message_id: messageId,
    text,
    reply_to: replyTo,
    ...(replyTo ? { event: { type: 'reply', replyTo } } : {}),
    account: accountId,
    payload: { account: accountId },
  });
}
