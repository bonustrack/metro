import { filled, isRecord } from '../read.js';
import { call } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';

export type Role = 'admin' | 'member';

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: Role;
}

export interface Organization {
  id: string;
  name: string | null;
  slug: string | null;
  self: string;
  role: Role;
  members: Member[];
}

const base = (): string => `${builtInDaemon()}/api/organization`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const roleOf = (value: unknown): Role => (value === 'admin' ? 'admin' : 'member');

function toMember(value: unknown): Member | null {
  if (!isRecord(value) || typeof value.membershipId !== 'string' || typeof value.userId !== 'string') return null;
  return { membershipId: value.membershipId, userId: value.userId, email: filled(value.email), name: filled(value.name), picture: filled(value.picture), role: roleOf(value.role) };
}

function toOrganization(body: unknown): Organization {
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.self !== 'string') throw unexpected();
  const members = Array.isArray(body.members) ? body.members.map(toMember).filter((m): m is Member => m !== null) : [];
  return { id: body.id, name: filled(body.name), slug: filled(body.slug), self: body.self, role: roleOf(body.role), members };
}

export const fetchOrganization = async (): Promise<Organization> => toOrganization(await call({ method: 'GET', base: base() }));

const json = (body: unknown): { headers: Record<string, string>; body: string } => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function renameOrganization(name: string): Promise<void> {
  await call({ method: 'PUT', base: base(), ...json({ name }) });
}

export async function setOrganizationSlug(slug: string): Promise<void> {
  await call({ method: 'PUT', base: base(), ...json({ slug }) });
}

export async function setOrganizationAvatar(avatar: string | null): Promise<void> {
  await call({ method: 'PUT', base: base(), path: '/avatar', ...json({ avatar }) });
}

export async function inviteMember(email: string, role: Role): Promise<void> {
  await call({ method: 'POST', base: base(), path: '/invitations', ...json({ email, role }) });
}

export async function setMemberRole(membershipId: string, role: Role): Promise<void> {
  await call({ method: 'PUT', base: base(), path: `/members/${membershipId}`, ...json({ role }) });
}

export async function removeMember(membershipId: string): Promise<void> {
  await call({ method: 'DELETE', base: base(), path: `/members/${membershipId}` });
}
