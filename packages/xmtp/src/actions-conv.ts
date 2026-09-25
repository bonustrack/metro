import { IdentifierKind } from '@xmtp/node-sdk';
import { accountForCall, convOf, lineOf, parseLine } from './accounts.js';
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

async function read(id: string, args: Args): Promise<void> {
  const { line, limit, before } = args as { line: string; limit?: number; before?: string };
  const { conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  const lim = Math.min(Math.max(1, limit ?? 20), 200);
  await conv.sync().catch(() => undefined);
  const all = await conv.messages();
  const slice = upTo(all, before).slice(-lim);
  const parsed = parseLine(line);
  if (!parsed)
    throw new TrainError('NOT_FOUND', `could not parse line ${line}`);
  const acctId = parsed.accountId;
  const messages = slice.map((m) => {
    let text = '';
    try {
      const cc: unknown = m.content;
      text =
        typeof cc === 'string' ? cc : `[${m.contentType?.typeId ?? 'unknown'}]`;
    } catch {
      text = `[${m.contentType?.typeId ?? 'unknown'}]`;
    }
    return {
      id: m.id,
      ts: new Date(Number(m.sentAtNs / 1_000_000n)).toISOString(),
      from: `metro://xmtp/${acctId}/user/${m.senderInboxId}`,
      text,
      contentType: m.contentType?.typeId ?? 'unknown',
    };
  });
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
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  respond(id, { result: await buildMemberList(acct, conv) });
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
