import type { MemberList, MetroMember } from '@metro-labs/mcp/stations/types';
import type { UserClient } from './client.js';

export interface RawUserMember {
  user: {
    id: number;
    username?: string | null;
    displayName?: string;
    isBot?: boolean;
  };
  status: string;
  title?: string | null;
}

const PAGE = 200;
const HARD_CAP = 2000;

export function mapUserMember(m: RawUserMember): MetroMember {
  const u = m.user;
  const member: MetroMember = { id: String(u.id) };
  if (u.username) member.name = u.username;
  if (u.displayName) member.display_name = u.displayName;
  if (m.title) member.roles = [m.title];
  member.is_admin = m.status === 'creator' || m.status === 'admin';
  member.is_bot = Boolean(u.isBot);
  return member;
}

export function restrictedMemberList(reason: string): MemberList {
  return { members: [], capability: { supported: false, complete: false, reason } };
}

const RESTRICTED_RE =
  /ADMIN|PRIVATE|CHAT_ADMIN_REQUIRED|not (a )?participant|permission|not enough rights/i;

export function isRestricted(msg: string): boolean {
  return RESTRICTED_RE.test(msg);
}

type Chunk = RawUserMember[] & { total?: number };

export async function fetchMembers(
  client: UserClient,
  chatId: number,
  limit?: number,
): Promise<MemberList> {
  const target = Math.min(Math.max(1, limit ?? PAGE), HARD_CAP);
  const collected: RawUserMember[] = [];
  let total = 0;
  for (let offset = 0; collected.length < target; ) {
    const want = Math.min(PAGE, target - collected.length);
    const getChatMembers = (
      client.tg as unknown as {
        getChatMembers: (
          id: number,
          p: { offset: number; limit: number },
        ) => Promise<Chunk>;
      }
    ).getChatMembers;
    const chunk = await getChatMembers.call(client.tg, chatId, {
      offset,
      limit: want,
    });
    total = chunk.total ?? collected.length + chunk.length;
    if (!chunk.length) break;
    collected.push(...chunk);
    offset += chunk.length;
    if (collected.length >= total || chunk.length < want) break;
  }
  const members = collected.map(mapUserMember);
  return {
    members,
    capability: { supported: true, complete: members.length >= total, total },
  };
}
