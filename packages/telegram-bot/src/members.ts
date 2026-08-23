import type { MemberList, MetroMember } from '@metro-labs/mcp/stations/types';

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

export interface TgChatMember {
  user: TgUser;
  status: string;
}

export function mapTgMember(m: TgChatMember): MetroMember {
  const u = m.user;
  const member: MetroMember = { id: String(u.id) };
  if (u.username) member.name = u.username;
  const display = [u.first_name, u.last_name].filter(Boolean).join(' ');
  if (display) member.display_name = display;
  member.is_admin = m.status === 'creator' || m.status === 'administrator';
  member.is_bot = Boolean(u.is_bot);
  return member;
}

const BOT_LIMIT_REASON =
  'Telegram Bot API cannot enumerate full membership; returning administrators only.';

export function adminMemberList(
  admins: TgChatMember[],
  total: number | null,
): MemberList {
  return {
    members: admins.map(mapTgMember),
    capability: {
      supported: true,
      complete: false,
      reason: BOT_LIMIT_REASON,
      ...(total != null ? { total } : {}),
    },
  };
}

export function inaccessibleMemberList(reason: string): MemberList {
  return { members: [], capability: { supported: false, complete: false, reason } };
}
