import { TrainError } from '@metro-labs/core/train-error';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { publicKeyFor, targetOf, type Account, type Target } from './accounts.js';
import { sendE2E } from './api.js';
import { bytesToHex, quoted, seal } from './crypto.js';
import { encodeFileFor, fileLabel, packFile, type OutgoingFile } from './files.js';
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
  attachments?: unknown;
}

const filesOf = (raw: unknown): OutgoingFile[] =>
  (Array.isArray(raw) ? raw : [])
    .map((a) => (a ?? {}) as Record<string, unknown>)
    .filter((a) => typeof a.path === 'string' && a.path !== '')
    .map((a) => ({ path: String(a.path), mime: typeof a.mime === 'string' && a.mime !== '' ? a.mime : 'application/octet-stream', name: typeof a.name === 'string' && a.name !== '' ? a.name : 'file' }));

function textOf(a: SendArgs, files: OutgoingFile[]): string {
  const text = typeof a.text === 'string' ? a.text : '';
  if (text === '' && files.length === 0)
    throw new TrainError('threema_text_required', 'give some text or a file to send', { retryable: false });
  return text;
}

async function sendFiles(acct: Account, target: Target, files: OutgoingFile[], caption: string | null): Promise<{ ids: string[]; labels: string[] }> {
  const ids: string[] = [];
  const labels: string[] = [];
  for (const [i, file] of files.entries()) {
    const packed = await packFile(acct, file, i === 0 ? caption : null);
    const sent = await fanOut(acct, target, encodeFileFor(null, packed), (g) => encodeFileFor(g, packed));
    ids.push(...sent);
    labels.push(fileLabel(file));
  }
  return { ids, labels };
}

function messageIdOf(raw: unknown, field: string): string {
  const id = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (!MESSAGE_ID_RE.test(id))
    throw new TrainError('threema_bad_message_id', `${field} must be a Threema message id, 16 hex characters`, { retryable: false });
  return id;
}

const replyTargetOf = (raw: unknown): string | undefined => (raw === undefined || raw === null || raw === '' ? undefined : messageIdOf(raw, 'replyTo'));

function bodyOf(text: string, replyTo: string | undefined): string {
  const body = replyTo === undefined ? text : quoted(replyTo, text);
  if (Buffer.byteLength(body, 'utf8') > MAX_TEXT_BYTES)
    throw new TrainError('threema_message_too_long', `Threema carries at most ${MAX_TEXT_BYTES} bytes of text per message; split it up`, { retryable: false });
  return body;
}

interface Sent {
  ids: string[];
  labels: string[];
}

const resultOf = (acct: Account, sent: Sent): Record<string, unknown> => ({
  messageId: sent.ids[0] ?? '',
  account: acct.cfg.id,
  ...(sent.ids.length > 1 ? { messageIds: sent.ids } : {}),
  ...(sent.labels.length > 0 ? { attachments: sent.labels } : {}),
});

export async function send(id: string, args: Args): Promise<void> {
  const a = args as unknown as SendArgs;
  const files = filesOf(a.attachments);
  const text = textOf(a, files);
  const replyTo = replyTargetOf(a.replyTo);
  const { acct, target } = targetOf(a.line, a.account);
  const body = bodyOf(text, replyTo);
  const sent: Sent =
    files.length === 0
      ? { ids: await fanOut(acct, target, encodeText(body), (g) => encodeGroupText(g, body)), labels: [] }
      : await sendFiles(acct, target, files, body === '' ? null : body);
  emitOutbound(acct.cfg.id, a.line, sent.ids[0] ?? '', text === '' ? `[${sent.labels.join(', ')}]` : text, replyTo);
  respond(id, { result: resultOf(acct, sent) });
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
