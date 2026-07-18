import { TrainError } from '@metro-labs/mcp/train-error';
import type { GroupResult } from '@metro-labs/mcp/stations/types';
import { accountForCall, convOf, lineOf } from './accounts.js';
import {
  applyMemberOp,
  createGroupWithMembers,
  warmGroupName,
} from './conv-helpers.js';
import { memberOutcomes, splitMembers } from './group-members.js';

type Args = Record<string, unknown>;

export async function groupCreate(args: Args): Promise<GroupResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new TrainError('INVALID_ARGS', 'groupCreate requires a `name`');
  const acct = accountForCall(args);
  const { addrs, inboxes } = splitMembers(args);
  const group = await createGroupWithMembers(acct, addrs, inboxes, {
    groupName: name,
  });
  warmGroupName(group.id, name);
  return {
    capability: { supported: true },
    line: lineOf(acct.cfg.id, group.id),
    id: group.id,
    name,
    members: memberOutcomes(addrs, inboxes, 'added'),
  };
}

async function memberOp(
  args: Args,
  mode: 'add' | 'remove',
  verb: string,
): Promise<GroupResult> {
  const line = typeof args.line === 'string' ? args.line : '';
  if (!line) throw new TrainError('INVALID_ARGS', `${verb} requires a \`line\``);
  const { addrs, inboxes } = splitMembers(args);
  if (!addrs.length && !inboxes.length)
    throw new TrainError('INVALID_ARGS', `${verb} requires members`);
  const { conv } = await convOf(line);
  if (!conv) throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  await applyMemberOp(conv, addrs, inboxes, mode);
  return {
    capability: { supported: true },
    line,
    id: conv.id,
    members: memberOutcomes(addrs, inboxes, mode === 'add' ? 'added' : 'removed'),
  };
}

export const groupAddMembers = (args: Args): Promise<GroupResult> =>
  memberOp(args, 'add', 'groupAddMembers');

export const groupRemoveMembers = (args: Args): Promise<GroupResult> =>
  memberOp(args, 'remove', 'groupRemoveMembers');
