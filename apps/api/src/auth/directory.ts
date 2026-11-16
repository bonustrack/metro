import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from '../db/client.js';
import { allOrganizations, createOrganizationRow, organizationNameOf, renameOrganizationRow, setUserName } from '../db/directory-rows.js';
import { addMember, landingMembership, membersOf, organizationsOf, rememberOrganization, removeMember, setMemberRole, type OrganizationMember } from '../db/memberships.js';
import type { AccountsMode } from './accounts-mode.js';
import * as workos from './workos.js';
import type { Invitation, Member, OrganizationSummary, Role, UserOrganization, WorkosConfig } from './workos.js';

export interface MemberChange {
  organization: string;
  member: Member;
  by: string;
}

export interface Directory {
  configured: () => boolean;
  organizationName: (id: string) => Promise<string | null>;
  userOrganizations: (user: string) => Promise<UserOrganization[]>;
  userMemberships: (user: string) => Promise<Pick<UserOrganization, 'id' | 'role'>[]>;
  landingOrganization: (user: string) => Promise<Pick<UserOrganization, 'id' | 'role'> | null>;
  rememberOrganization: (user: string, organization: string) => Promise<void>;
  listMembers: (organization: string) => Promise<Member[]>;
  listInvitations: (organization: string) => Promise<Invitation[]>;
  listOrganizations: () => Promise<OrganizationSummary[]>;
  createOrganization: (name: string, creator: string) => Promise<string>;
  renameOrganization: (id: string, name: string) => Promise<string>;
  invite: (organization: string, email: string, role: Role, by: string) => Promise<Record<string, unknown>>;
  revokeInvitation: (organization: string, id: string) => Promise<void>;
  setMembershipRole: (change: MemberChange & { role: Role }) => Promise<void>;
  removeMembership: (change: MemberChange) => Promise<void>;
  updateUserName: (user: string, first: string, last: string | null) => Promise<void>;
}

export function workosDirectory(config: () => WorkosConfig | null): Directory {
  const cfg = (): WorkosConfig => workos.configOf({ config });
  return {
    configured: () => config() !== null,
    organizationName: (id) => {
      const held = config();
      return held === null ? Promise.resolve(null) : workos.organizationName(held, id);
    },
    userOrganizations: (user) => workos.userOrganizations(cfg(), user),
    userMemberships: (user) => workos.userMemberships(cfg(), user),
    landingOrganization: async (user) => (await workos.userMemberships(cfg(), user))[0] ?? null,
    rememberOrganization: () => Promise.resolve(),
    listMembers: (organization) => workos.listMembers(cfg(), organization),
    listInvitations: (organization) => workos.listInvitations(cfg(), organization),
    listOrganizations: () => workos.listOrganizations(cfg()),
    createOrganization: async (name, creator) => {
      const id = await workos.createOrganization(cfg(), name);
      await workos.addMembership(cfg(), creator, id, 'admin');
      return id;
    },
    renameOrganization: (id, name) => workos.renameOrganization(cfg(), id, name),
    invite: async (organization, email, role, by) => ({ ...(await workos.sendInvitation(cfg(), organization, email, role, by)) }),
    revokeInvitation: async (_organization, id) => {
      await workos.revokeInvitation(cfg(), id);
    },
    setMembershipRole: async ({ member, role }) => {
      await workos.setMembershipRole(cfg(), member.membershipId, role);
    },
    removeMembership: async ({ member }) => {
      await workos.removeMembership(cfg(), member.membershipId);
    },
    updateUserName: (user, first, last) => workos.updateUserName(cfg(), user, first, last),
  };
}

const fullName = (first: string, last: string | null): string => (last === null ? first : `${first} ${last}`);

const signedInSince = (m: OrganizationMember): boolean => m.addedBy === null || (m.lastLoginAt !== null && Date.parse(m.lastLoginAt) >= m.createdAt);

async function members(db: Database, organization: string): Promise<Member[]> {
  return (await membersOf(db, organization)).map((m) => {
    const shown = signedInSince(m);
    return { membershipId: m.id, userId: m.user, email: m.email, name: shown ? m.name : null, picture: shown ? m.picture : null, role: m.role };
  });
}

export function metroDirectory(db: () => Database, now: () => number = Date.now): Directory {
  return {
    configured: () => true,
    organizationName: (id) => organizationNameOf(db(), id),
    userOrganizations: async (user) => (await organizationsOf(db(), user)).map((o) => ({ id: o.id, name: o.name, role: o.role })),
    userMemberships: async (user) => (await organizationsOf(db(), user)).map((o) => ({ id: o.id, role: o.role })),
    landingOrganization: (user) => landingMembership(db(), user),
    rememberOrganization: (user, organization) => rememberOrganization(db(), user, organization),
    listMembers: (organization) => members(db(), organization),
    listInvitations: () => Promise.resolve([]),
    listOrganizations: () => allOrganizations(db()),
    createOrganization: async (name, creator) => (await createOrganizationRow(db(), { name, creator, now: now() })).id,
    renameOrganization: (id, name) => renameOrganizationRow(db(), id, name, now()),
    invite: async (organization, email, role, by) => {
      const added = await addMember(db(), { organization, email, role, by, now: now() });
      return { added: true, member: { membershipId: added.id, email: added.email, role } };
    },
    revokeInvitation: () => Promise.reject(new ApiError('no such invitation', 404)),
    setMembershipRole: ({ organization, member, by, role }) => setMemberRole(db(), { organization, user: member.userId, by, role, now: now() }),
    removeMembership: ({ organization, member, by }) => removeMember(db(), { organization, user: member.userId, by }),
    updateUserName: (user, first, last) => setUserName(db(), user, fullName(first, last), now()),
  };
}

export function directoryFor(mode: AccountsMode, config: () => WorkosConfig | null, db: () => Database): Directory {
  return mode === 'metro' ? metroDirectory(db) : workosDirectory(config);
}
