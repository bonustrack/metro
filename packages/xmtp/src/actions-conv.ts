import { IdentifierKind, type DecodedMessage } from '@xmtp/node-sdk';
import { accountForCall, convOf, lineOf, type Account } from './accounts.js';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { resolveMsgId } from './wire.js';
import { TrainError } from '@metro-labs/core/train-error';
import {
  buildGroupInfo,
  buildMemberList,
} from './conv-helpers.js';
import { closeGroup } from './actions-close.js';
import {
  groupAddMembers,
  groupCreate,
  groupRemoveMembers,
} from './group.js';
import { updateChannelMeta } from './actions-meta.js';
import { deletedByRequests, isDeleteRequest, superAdminCheck } from './delete-requests.js';
import { isCallSignal } from './codecs.js';
import { syncConversation } from './network.js';
import { readAttachments } from './read-attachments.js';

type Args = Record<string, unknown>;
type Handler = (id: string, args: Args) => Promise<void>;

async function newDm(id: string, args: Args): Promise<void> {
  const { address } = args as { address: string };
  const acct = accountForCall(args);
  const dm = await acct.client.conversations.createDmWithIdentifier({
    identifier: address,
    identifierKind: IdentifierKind.Ethereum,
  });
  respond(id, {
    result: {
      line: lineOf(acct.cfg.id, dm.id),
      id: dm.id,
      account: acct.cfg.id,
    },
  });
}

function upTo<T extends { id: string }>(all: T[], before: string | undefined): T[] {
  if (!before) return all;
  const target = resolveMsgId(before);
  const at = all.findIndex((m) => m.id === target);
  if (at < 0) throw new TrainError('NOT_FOUND', `message ${before} is not in this conversation`);
  return all.slice(0, at);
}

function textOf(m: DecodedMessage): string {
  try {
    const cc: unknown = m.content;
    return typeof cc === 'string' ? cc : `[${m.contentType?.typeId ?? 'unknown'}]`;
  } catch {
    return `[${m.contentType?.typeId ?? 'unknown'}]`;
  }
}

const DELETED = { text: '[deletedMessage]', contentType: 'deletedMessage' };

function messageOf(acct: Account, m: DecodedMessage, deleted: Set<string>): Record<string, unknown> {
  return {
    id: m.id,
    ts: new Date(Number(m.sentAtNs / 1_000_000n)).toISOString(),
    from: `metro://xmtp/${acct.cfg.id}/user/${m.senderInboxId}`,
    ...(m.senderInboxId === acct.inboxId ? { self: true } : {}),
    ...(deleted.has(m.id) ? DELETED : { text: textOf(m), contentType: m.contentType?.typeId ?? 'unknown' }),
  };
}

async function read(id: string, args: Args): Promise<void> {
  const { line, limit, before, messageId } = args as { line: string; limit?: number; before?: string; messageId?: string };
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  await syncConversation(acct.client, conv);
  const all = await conv.messages();
  if (messageId) {
    const target = resolveMsgId(messageId);
    const message = acct.client.conversations.getMessageById(target);
    if (message?.conversationId !== conv.id || isDeleteRequest(message) || isCallSignal(message))
      throw new TrainError('NOT_FOUND', `message ${messageId} is not in this conversation`);
    const deleted = deletedByRequests([...all, message], superAdminCheck(conv));
    const attachments = deleted.has(message.id) ? [] : await readAttachments(message);
    respond(id, { result: { line, account: acct.cfg.id, message: { ...messageOf(acct, message, deleted), attachments } } });
    return;
  }
  const lim = Math.min(Math.max(1, limit ?? 20), 200);
  const deleted = deletedByRequests(all, superAdminCheck(conv));
  const slice = upTo(all.filter((m) => !isDeleteRequest(m) && !isCallSignal(m)), before).slice(-lim);
  const messages = slice.map((m) => messageOf(acct, m, deleted));
  respond(id, { result: { line, count: messages.length, messages } });
}

async function groupInfo(id: string, args: Args): Promise<void> {
  const { line } = args as { line: string };
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  respond(id, { result: await buildGroupInfo(line, acct, conv) });
}

async function listMembers(id: string, args: Args): Promise<void> {
  const { line } = args as { line: string };
  const { conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  respond(id, { result: await buildMemberList(conv) });
}

export const convHandlers: Record<string, Handler> = {
  newDm,
  updateChannelMeta,
  closeGroup,
  read,
  groupInfo,
  listMembers,
  groupCreate: async (id, args) => {
    respond(id, { result: await groupCreate(args) });
  },
  groupAddMembers: async (id, args) => {
    respond(id, { result: await groupAddMembers(args) });
  },
  groupRemoveMembers: async (id, args) => {
    respond(id, { result: await groupRemoveMembers(args) });
  },
};
