import type {
  GroupResult,
  MemberOutcome,
} from '@metro-labs/mcp/stations/types';
import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
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

const ADD_FAILURE_CODES = [
  'CHAT_MEMBER_ADD_FAILED',
  'USER_PRIVACY_RESTRICTED',
  'USER_NOT_MUTUAL_CONTACT',
  'USER_CHANNELS_TOO_MUCH',
  'USER_ALREADY_PARTICIPANT',
  'USER_BLOCKED',
  'USER_BOT',
  'USER_KICKED',
  'PEER_FLOOD',
  'USERS_TOO_MUCH',
];

function isAddFailure(e: unknown): boolean {
  const msg = errMsg(e).toUpperCase();
  return ADD_FAILURE_CODES.some((code) => msg.includes(code));
}

const added = (id: string): MemberOutcome => ({ id, status: 'added' });
const invited = (id: string): MemberOutcome => ({
  id,
  status: 'invited',
  reason: INVITE_REASON,
});

function membersOf(args: Record<string, unknown>): string[] {
  const raw = args.members;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}

async function addOne(
  client: UserClient,
  chatId: number,
  member: string,
): Promise<MemberOutcome> {
  try {
    const missing = await tgGroup(client).addChatMembers(chatId, [member], {
      forwardCount: 0,
    });
    return missing.length ? invited(member) : added(member);
  } catch (e) {
    if (isAddFailure(e)) return invited(member);
    throw e;
  }
}

interface CreatedChat {
  chatId: number;
  outcomes: MemberOutcome[];
}

async function createWithAll(
  client: UserClient,
  title: string,
  members: string[],
): Promise<CreatedChat> {
  const res = await tgGroup(client).createGroup({ title, users: members });
  const missing = new Set(res.missing.map((m) => m.userId));
  const outcomes: MemberOutcome[] = [];
  for (const m of members) {
    const uid = await idOf(client, m);
    outcomes.push(
      uid !== null && missing.has(Number(uid)) ? invited(m) : added(m),
    );
  }
  return { chatId: res.chat.id, outcomes };
}

async function createPerMember(
  client: UserClient,
  title: string,
  members: string[],
): Promise<CreatedChat> {
  let chatId: number | null = null;
  const outcomes: MemberOutcome[] = [];
  const pending: string[] = [];
  for (const m of members) {
    if (chatId !== null) {
      pending.push(m);
      continue;
    }
    try {
      const res = await tgGroup(client).createGroup({ title, users: [m] });
      chatId = res.chat.id;
      outcomes.push(res.missing.length ? invited(m) : added(m));
    } catch (e) {
      if (!isAddFailure(e)) throw e;
      outcomes.push(invited(m));
    }
  }
  if (chatId === null)
    throw new TrainError(
      'telegram_user_call',
      'could not create group: no requested member could be added',
    );
  for (const m of pending) outcomes.push(await addOne(client, chatId, m));
  return { chatId, outcomes };
}

async function createChat(
  client: UserClient,
  title: string,
  members: string[],
): Promise<CreatedChat> {
  try {
    return await createWithAll(client, title, members);
  } catch (e) {
    if (!isAddFailure(e)) throw e;
    return createPerMember(client, title, members);
  }
}

async function finalize(
  client: UserClient,
  base: GroupResult,
  chatId: number,
  outcomes: MemberOutcome[],
): Promise<GroupResult> {
  const result: GroupResult = { ...base, members: outcomes };
  if (outcomes.some((o) => o.status === 'invited'))
    result.inviteLink = (await tgGroup(client).exportInviteLink(chatId)).link;
  return result;
}

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

export async function groupCreate(
  client: UserClient,
  accountId: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new TrainError('bad_request', 'groupCreate requires a `name`');
  const members = membersOf(args);
  if (!members.length)
    throw new TrainError('bad_request', 'groupCreate requires `members`');
  const { chatId, outcomes } = await createChat(client, name, members);
  return finalize(
    client,
    {
      capability: { supported: true },
      line: lineOf(accountId, chatId),
      id: String(chatId),
      name,
    },
    chatId,
    outcomes,
  );
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
  const outcomes: MemberOutcome[] = [];
  for (const m of members) outcomes.push(await addOne(client, chatId, m));
  return finalize(
    client,
    { capability: { supported: true }, line, id: String(chatId) },
    chatId,
    outcomes,
  );
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
