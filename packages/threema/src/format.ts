import { emit, mintId } from '@metro-labs/core/stations/station-runtime';
import { unquote } from './crypto.js';
import { groupKey } from './groups.js';
import { RECEIPT_ACK, RECEIPT_DECLINE, type GroupRef } from './messages.js';

const SELF_URI = process.env.METRO_SELF_URI ?? '';

const REACTION_OF: Record<number, string> = {
  [RECEIPT_ACK]: '👍',
  [RECEIPT_DECLINE]: '👎',
};

export const lineOf = (accountId: string, threemaId: string): string =>
  `metro://threema/${accountId}/${threemaId}`;

export const groupLineOf = (accountId: string, group: GroupRef): string =>
  `metro://threema/${accountId}/${groupKey(group)}`;

const userOf = (accountId: string, threemaId: string): string =>
  `metro://threema/${accountId}/user/${threemaId}`;

export interface InboundMeta {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nickname?: string;
}

export interface Room {
  group: GroupRef | null;
  name: string | null;
}

export const DIRECT: Room = { group: null, name: null };

const MENTION_ALL = '@@@@@@@@';

export const mentionsSelf = (text: string, self: string): boolean =>
  text.includes(MENTION_ALL) || text.toUpperCase().includes(`@@${self.toUpperCase()}`);

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
  room: Room,
): Record<string, unknown> {
  const group = room.group;
  return {
    kind: 'inbound',
    id: mintId(),
    ts: tsOf(m.date),
    station: 'threema',
    line: group === null ? lineOf(accountId, m.from) : groupLineOf(accountId, group),
    line_name: group === null ? (m.nickname ?? m.from) : (room.name ?? groupKey(group)),
    from: userOf(accountId, m.from),
    from_name: m.nickname,
    from_display_name: m.nickname,
    is_private: group === null,
    payload: { from: m.from, to: m.to, nickname: m.nickname ?? null, type, ...(group === null ? {} : { group: groupKey(group) }) },
  };
}

export function textEnvelope(
  accountId: string,
  m: InboundMeta,
  raw: string,
  sentByUs: (messageId: string) => boolean,
  room: Room = DIRECT,
): Record<string, unknown> {
  const { replyTo, text } = unquote(raw);
  return {
    ...base(accountId, m, 'text', room),
    message_id: m.messageId,
    text,
    ...(room.group !== null && mentionsSelf(text, m.to) ? { mentions_self: true } : {}),
    ...(replyTo === undefined
      ? {}
      : {
          reply_to: replyTo,
          event: { type: 'reply', replyTo },
          reply_to_self: sentByUs(replyTo),
        }),
  };
}

export function reactionEnvelope(
  accountId: string,
  m: InboundMeta,
  emoji: string,
  targetId: string,
  removed: boolean,
  room: Room = DIRECT,
  type = 'reaction',
): Record<string, unknown> {
  return {
    ...base(accountId, m, type, room),
    message_id: `${m.messageId}:${targetId}`,
    text: `[react ${emoji}${removed ? ' (removed)' : ''}]`,
    emoji,
    event: { type: 'react', emoji, targetId, ...(removed ? { removed: true } : {}) },
  };
}

export function receiptEnvelope(
  accountId: string,
  m: InboundMeta,
  status: number,
  targetId: string,
  room: Room = DIRECT,
): Record<string, unknown> | null {
  const emoji = REACTION_OF[status];
  return emoji === undefined ? null : reactionEnvelope(accountId, m, emoji, targetId, false, room, 'receipt');
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

export function emitOutboundReaction(
  accountId: string,
  line: string,
  messageId: string,
  emoji: string,
  targetId: string,
  removed: boolean,
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
    text: `[react ${emoji}${removed ? ' (removed)' : ''}]`,
    emoji,
    event: { type: 'react', emoji, targetId, ...(removed ? { removed: true } : {}) },
    account: accountId,
    payload: { account: accountId },
  });
}
