import { TrainError } from '@metro-labs/core/train-error';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { publicKeyFor, targetOf, type Account, type Target } from './accounts.js';
import { sendE2E } from './api.js';
import { bytesToHex, quoted, seal } from './crypto.js';
import { emitOutbound, emitOutboundReaction } from './format.js';
import { MESSAGE_ID_RE } from './ids.js';
import {
  encodeGroupReaction,
  encodeGroupSyncRequest,
  encodeGroupText,
  encodeReaction,
  encodeText,
  type GroupRef,
} from './messages.js';

export const MAX_TEXT_BYTES = 3500;
const SENT_MAX = 2000;

type Args = Record<string, unknown>;

const sentIds = new Set<string>();

export function noteSent(messageId: string): void {
  sentIds.add(messageId);
  while (sentIds.size > SENT_MAX) {
    const oldest = sentIds.values().next();
    if (oldest.done) break;
    sentIds.delete(oldest.value);
  }
}

export const sentByUs = (messageId: string): boolean => sentIds.has(messageId);

async function deliver(acct: Account, to: string, plain: Uint8Array, group: boolean): Promise<string> {
  const { nonce, box } = seal(plain, await publicKeyFor(acct, to), acct.keys);
  const messageId = await sendE2E(acct.cfg, to, bytesToHex(nonce), bytesToHex(box), group);
  noteSent(messageId);
  return messageId;
}

function recipientsOf(acct: Account, group: GroupRef): string[] {
  const members = acct.groups.recipients(group);
  if (members === null)
    throw new TrainError(
      'threema_unknown_group',
      'metro has not received this group\'s member list yet; it asked the group creator for it, try again in a moment',
      { retryable: true },
    );
  return members;
}

export async function requestSync(acct: Account, group: GroupRef): Promise<void> {
  await deliver(acct, group.creator, encodeGroupSyncRequest(group.groupId), true);
}

async function fanOut(acct: Account, target: Target, direct: Uint8Array, grouped: (g: GroupRef) => Uint8Array): Promise<string[]> {
  if (target.kind === 'user') return [await deliver(acct, target.id, direct, false)];
  const ids: string[] = [];
  for (const member of recipientsOf(acct, target.group)) ids.push(await deliver(acct, member, grouped(target.group), true));
  if (ids.length === 0) throw new TrainError('threema_empty_group', 'nobody else is in this group', { retryable: false });
  return ids;
}

interface SendArgs {
  line: string;
  text?: unknown;
  replyTo?: unknown;
  account?: string;
}

function requireText(a: SendArgs): string {
  const text = typeof a.text === 'string' ? a.text : '';
  if (text === '')
    throw new TrainError('threema_text_required', 'threema carries text only; give some text to send', { retryable: false });
  return text;
}

function messageIdOf(raw: unknown, field: string): string {
  const id = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (!MESSAGE_ID_RE.test(id))
    throw new TrainError('threema_bad_message_id', `${field} must be a Threema message id, 16 hex characters`, { retryable: false });
  return id;
}

export async function send(id: string, args: Args): Promise<void> {
  const a = args as unknown as SendArgs;
  const text = requireText(a);
  const replyTo = a.replyTo === undefined || a.replyTo === null || a.replyTo === '' ? undefined : messageIdOf(a.replyTo, 'replyTo');
  const { acct, target } = targetOf(a.line, a.account);
  const body = replyTo === undefined ? text : quoted(replyTo, text);
  if (Buffer.byteLength(body, 'utf8') > MAX_TEXT_BYTES)
    throw new TrainError('threema_message_too_long', `Threema carries at most ${MAX_TEXT_BYTES} bytes of text per message; split it up`, { retryable: false });
  const ids = await fanOut(acct, target, encodeText(body), (g) => encodeGroupText(g, body));
  const messageId = ids[0] ?? '';
  emitOutbound(acct.cfg.id, a.line, messageId, text, replyTo);
  respond(id, { result: { messageId, account: acct.cfg.id, ...(ids.length > 1 ? { messageIds: ids } : {}) } });
}

interface ReactArgs {
  line: string;
  messageId?: unknown;
  emoji?: unknown;
  account?: string;
  action?: unknown;
}

export async function react(id: string, args: Args): Promise<void> {
  const a = args as unknown as ReactArgs;
  const emoji = typeof a.emoji === 'string' ? a.emoji.trim() : '';
  if (emoji === '') throw new TrainError('threema_emoji_required', 'react needs an emoji', { retryable: false });
  const messageId = messageIdOf(a.messageId, 'messageId');
  const removed = a.action === 'removed';
  const { acct, target } = targetOf(a.line, a.account);
  const ids = await fanOut(acct, target, encodeReaction(messageId, emoji, removed), (g) => encodeGroupReaction(g, messageId, emoji, removed));
  emitOutboundReaction(acct.cfg.id, a.line, ids[0] ?? '', emoji, messageId, removed);
  respond(id, { result: { messageId: ids[0] ?? '', account: acct.cfg.id, emoji, removed } });
}
