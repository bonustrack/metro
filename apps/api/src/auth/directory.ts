import type { Database } from '../db/client.js';
import { allOrganizations, createOrganizationRow, organizationNameOf, renameOrganizationRow, setUserName } from '../db/directory-rows.js';
import { addMember, landingMembership, membersOf, organizationsOf, rememberOrganization, removeMember, setMemberRole, type OrganizationMember } from '../db/memberships.js';

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: string;
}

export type Role = 'admin' | 'member';
export const isRole = (value: unknown): value is Role => value === 'admin' || value === 'member';

export const ORGANIZATION_NAME_RE = /^[^\p{Cc}]{2,64}$/u;

export interface UserOrganization {
  id: string;
  name: string | null;
  role: string | null;
}

export interface OrganizationSummary {
  id: string;
  name: string | null;
  createdAt: string | null;
}

export interface MemberChange {
  organization: string;
  member: Member;
  by: string;
}

export interface Directory {
  organizationName: (id: string) => Promise<string | null>;
  userOrganizations: (user: string) => Promise<UserOrganization[]>;
  userMemberships: (user: string) => Promise<Pick<UserOrganization, 'id' | 'role'>[]>;
  landingOrganization: (user: string) => Promise<Pick<UserOrganization, 'id' | 'role'> | null>;
  rememberOrganization: (user: string, organization: string) => Promise<void>;
  listMembers: (organization: string) => Promise<Member[]>;
  listOrganizations: () => Promise<OrganizationSummary[]>;
  createOrganization: (name: string, creator: string) => Promise<string>;
  renameOrganization: (id: string, name: string) => Promise<string>;
  addMember: (organization: string, email: string, role: Role, by: string) => Promise<Record<string, unknown>>;
  setMembershipRole: (change: MemberChange & { role: Role }) => Promise<void>;
  removeMembership: (change: MemberChange) => Promise<void>;
  updateUserName: (user: string, first: string, last: string | null) => Promise<void>;
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
    organizationName: (id) => organizationNameOf(db(), id),
    userOrganizations: async (user) => (await organizationsOf(db(), user)).map((o) => ({ id: o.id, name: o.name, role: o.role })),
    userMemberships: async (user) => (await organizationsOf(db(), user)).map((o) => ({ id: o.id, role: o.role })),
    landingOrganization: (user) => landingMembership(db(), user),
    rememberOrganization: (user, organization) => rememberOrganization(db(), user, organization),
    listMembers: (organization) => members(db(), organization),
    listOrganizations: () => allOrganizations(db()),
    createOrganization: async (name, creator) => (await createOrganizationRow(db(), { name, creator, now: now() })).id,
    renameOrganization: (id, name) => renameOrganizationRow(db(), id, name, now()),
    addMember: async (organization, email, role, by) => {
      const added = await addMember(db(), { organization, email, role, by, now: now() });
      return { added: true, member: { membershipId: added.id, email: added.email, role } };
    },
    setMembershipRole: ({ organization, member, by, role }) => setMemberRole(db(), { organization, user: member.userId, by, role, now: now() }),
    removeMembership: ({ organization, member, by }) => removeMember(db(), { organization, user: member.userId, by }),
    updateUserName: (user, first, last) => setUserName(db(), user, fullName(first, last), now()),
  };
}
