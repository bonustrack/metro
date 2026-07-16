import { errMsg } from '@metro-labs/mcp/log';
import type { MemberList, MetroMember } from '@metro-labs/mcp/stations/types';
import { rest } from './accounts.js';

export interface DiscordRole {
  id: string;
  name: string;
  permissions: string;
}

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordGuildMember {
  user?: DiscordUser;
  nick?: string | null;
  roles?: string[];
}

const ADMINISTRATOR = 1n << 3n;
const PAGE = 1000;

export interface RoleInfo {
  name: string;
  admin: boolean;
}

function roleIsAdmin(permissions: string): boolean {
  try {
    return (BigInt(permissions) & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

export function indexRoles(roles: DiscordRole[]): Map<string, RoleInfo> {
  const out = new Map<string, RoleInfo>();
  for (const r of roles)
    out.set(r.id, { name: r.name, admin: roleIsAdmin(r.permissions) });
  return out;
}

function isAdmin(
  userId: string,
  roleIds: string[],
  roles: Map<string, RoleInfo>,
  ownerId?: string,
): boolean {
  if (ownerId !== undefined && userId === ownerId) return true;
  return roleIds.some((id) => roles.get(id)?.admin === true);
}

export function mapGuildMember(
  m: DiscordGuildMember,
  roles: Map<string, RoleInfo>,
  ownerId?: string,
): MetroMember | null {
  const user = m.user;
  if (!user?.id) return null;
  const member: MetroMember = { id: user.id };
  if (user.username) member.name = user.username;
  const display = m.nick ?? user.global_name ?? undefined;
  if (display) member.display_name = display;
  const roleIds = m.roles ?? [];
  const roleNames = roleIds
    .map((id) => roles.get(id)?.name)
    .filter((n): n is string => Boolean(n));
  if (roleNames.length) member.roles = roleNames;
  member.is_admin = isAdmin(user.id, roleIds, roles, ownerId);
  member.is_bot = Boolean(user.bot);
  return member;
}

export function mapGuildMembers(
  members: DiscordGuildMember[],
  roles: Map<string, RoleInfo>,
  ownerId?: string,
): MetroMember[] {
  return members
    .map((m) => mapGuildMember(m, roles, ownerId))
    .filter((x): x is MetroMember => x !== null);
}

export function mapRecipients(users: DiscordUser[]): MetroMember[] {
  return users
    .filter((u) => Boolean(u?.id))
    .map((u) => {
      const m: MetroMember = { id: u.id };
      if (u.username) m.name = u.username;
      if (u.global_name) m.display_name = u.global_name;
      m.is_bot = Boolean(u.bot);
      return m;
    });
}

async function fetchRoles(
  accountId: string,
  guildId: string,
): Promise<Map<string, RoleInfo>> {
  try {
    const roles = await rest<DiscordRole[]>(
      accountId,
      'GET',
      `/guilds/${guildId}/roles`,
    );
    return indexRoles(roles);
  } catch {
    return new Map();
  }
}

async function fetchOwnerId(
  accountId: string,
  guildId: string,
): Promise<string | undefined> {
  try {
    const g = await rest<{ owner_id?: string }>(
      accountId,
      'GET',
      `/guilds/${guildId}`,
    );
    return g.owner_id;
  } catch {
    return undefined;
  }
}

interface Collected {
  raw: DiscordGuildMember[];
  exhausted: boolean;
}

async function paginate(
  accountId: string,
  guildId: string,
  cap: number,
): Promise<Collected> {
  const raw: DiscordGuildMember[] = [];
  let after: string | undefined;
  for (;;) {
    const want = Math.min(PAGE, cap - raw.length);
    if (want <= 0) return { raw, exhausted: false };
    const qs = new URLSearchParams({ limit: String(want) });
    if (after) qs.set('after', after);
    const page = await rest<DiscordGuildMember[]>(
      accountId,
      'GET',
      `/guilds/${guildId}/members?${qs}`,
    );
    raw.push(...page);
    if (page.length < want) return { raw, exhausted: true };
    after = page[page.length - 1]?.user?.id;
    if (!after) return { raw, exhausted: true };
  }
}

const INTENT_HINT =
  'Discord bot lacks the privileged GUILD_MEMBERS intent (enable it in the ' +
  'Developer Portal) or channel access; returning what is reachable.';

export async function listGuildMembers(
  accountId: string,
  guildId: string,
  limit?: number,
): Promise<MemberList> {
  const cap = Math.min(Math.max(1, limit ?? PAGE), 10_000);
  const roles = await fetchRoles(accountId, guildId);
  const ownerId = await fetchOwnerId(accountId, guildId);
  try {
    const { raw, exhausted } = await paginate(accountId, guildId, cap);
    const members = mapGuildMembers(raw, roles, ownerId);
    return {
      members,
      capability: exhausted
        ? { supported: true, complete: true, total: members.length }
        : {
            supported: true,
            complete: false,
            reason: `truncated at limit ${cap}`,
          },
    };
  } catch (e) {
    const msg = errMsg(e);
    if (/\b40[13]\b/.test(msg))
      return {
        members: [],
        capability: { supported: false, complete: false, reason: INTENT_HINT },
      };
    throw e;
  }
}

export async function discordMembers(
  accountId: string,
  channelId: string,
  limit?: number,
): Promise<MemberList> {
  const chan = await rest<{ guild_id?: string; recipients?: DiscordUser[] }>(
    accountId,
    'GET',
    `/channels/${channelId}`,
  );
  if (!chan.guild_id) {
    const members = mapRecipients(chan.recipients ?? []);
    return {
      members,
      capability: { supported: true, complete: true, total: members.length },
    };
  }
  return listGuildMembers(accountId, chan.guild_id, limit);
}
