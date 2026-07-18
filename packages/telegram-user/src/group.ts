import type {
  GroupResult,
  MemberOutcome,
} from '@metro-labs/mcp/stations/types';
import { TrainError } from '@metro-labs/mcp/train-error';
import type { UserClient } from './client.js';
import { lineOf } from './accounts.js';

export interface MissingInvitee {
  userId: number;
}

interface CreateGroupResponse {
  chat: { id: number };
  missing: MissingInvitee[];
}

interface InviteLink {
  link: string;
}

interface TgGroup {
  createGroup: (p: {
    title: string;
    users: string[];
  }) => Promise<CreateGroupResponse>;
  addChatMembers: (
    chatId: number,
    users: string[],
    params: { forwardCount: number },
  ) => Promise<MissingInvitee[]>;
  kickChatMember: (p: { chatId: number; userId: string }) => Promise<unknown>;
  exportInviteLink: (chatId: number) => Promise<InviteLink>;
  resolvePeer: (peer: string) => Promise<{
    userId?: number;
    channelId?: number;
    chatId?: number;
  }>;
}

const tgGroup = (client: UserClient): TgGroup => {
  const tg: unknown = client.tg;
  return tg as TgGroup;
};

const INVITE_REASON =
  'could not be direct-added (not a mutual contact or privacy-restricted); share the invite link';

async function idOf(client: UserClient, member: string): Promise<string | null> {
  const trimmed = member.replace(/^@/, '');
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  try {
    const peer = await tgGroup(client).resolvePeer(member);
    const uid = peer.userId ?? peer.channelId ?? peer.chatId;
    return uid !== undefined ? String(uid) : null;
  } catch {
    return null;
  }
}

export async function classifyMembers(
  client: UserClient,
  members: string[],
  missing: MissingInvitee[],
): Promise<MemberOutcome[]> {
  const missingSet = new Set(missing.map((m) => String(m.userId)));
  const outcomes: MemberOutcome[] = [];
  for (const m of members) {
    const uid = await idOf(client, m);
    const invited = uid !== null && missingSet.has(uid);
    outcomes.push(
      invited
        ? { id: m, status: 'invited', reason: INVITE_REASON }
        : { id: m, status: 'added' },
    );
  }
  return outcomes;
}

function membersOf(args: Record<string, unknown>): string[] {
  const raw = args.members;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}

export async function groupCreate(
  client: UserClient,
  accountId: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new TrainError('bad_request', 'groupCreate requires a `name`');
  const members = membersOf(args);
  const res = await tgGroup(client).createGroup({ title: name, users: members });
  const chatId = res.chat.id;
  const outcomes = await classifyMembers(client, members, res.missing);
  const result: GroupResult = {
    capability: { supported: true },
    line: lineOf(accountId, chatId),
    id: String(chatId),
    name,
    members: outcomes,
  };
  if (res.missing.length)
    result.inviteLink = (
      await tgGroup(client).exportInviteLink(chatId)
    ).link;
  return result;
}

export async function groupAddMembers(
  client: UserClient,
  chatId: number,
  line: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const members = membersOf(args);
  if (!members.length)
    throw new TrainError('bad_request', 'groupAddMembers requires `members`');
  const missing = await tgGroup(client).addChatMembers(chatId, members, {
    forwardCount: 0,
  });
  const outcomes = await classifyMembers(client, members, missing);
  const result: GroupResult = {
    capability: { supported: true },
    line,
    id: String(chatId),
    members: outcomes,
  };
  if (missing.length)
    result.inviteLink = (
      await tgGroup(client).exportInviteLink(chatId)
    ).link;
  return result;
}

export async function groupRemoveMembers(
  client: UserClient,
  chatId: number,
  line: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const members = membersOf(args);
  if (!members.length)
    throw new TrainError('bad_request', 'groupRemoveMembers requires `members`');
  for (const m of members)
    await tgGroup(client).kickChatMember({ chatId, userId: m });
  return {
    capability: { supported: true },
    line,
    id: String(chatId),
    members: members.map((id) => ({ id, status: 'removed' as const })),
  };
}

export async function groupInviteLink(
  client: UserClient,
  chatId: number,
  line: string,
): Promise<GroupResult> {
  const link = await tgGroup(client).exportInviteLink(chatId);
  return {
    capability: { supported: true },
    line,
    id: String(chatId),
    inviteLink: link.link,
  };
}
