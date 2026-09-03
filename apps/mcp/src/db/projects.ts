import { ensureUser, normalizeEmail, userIdForEmail } from './users.js';
import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { projectMembers, projects, users, type ProjectRole } from './schema.js';

export class ProjectError extends ApiError {}

export interface Project {
  id: string;
  name: string;
  isDefault: boolean;
  owner: boolean;
  role: ProjectRole;
}

export interface Member {
  id: string;
  email: string;
  role: ProjectRole;
  owner: boolean;
}

const NAME_MAX = 64;
const CONTROL = /[\u0000-\u001f\u007f]/;

const missing = (): ProjectError => new ProjectError('no such project', 404);
const forbidden = (why: string): ProjectError => new ProjectError(why, 403);

export function projectName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '' || name.length > NAME_MAX)
    throw new ProjectError(
      `a project name is 1-${String(NAME_MAX)} characters`,
      400,
    );
  if (CONTROL.test(name))
    throw new ProjectError('a project name cannot carry control characters', 400);
  return name;
}

export interface Access {
  userId: string;
  projectId: string;
  ownerId: string;
  isDefault: boolean;
  name: string;
  role: ProjectRole;
}

export async function memberAccessOrThrow(
  email: string,
  projectId: string,
): Promise<Access> {
  const userId = await userIdForEmail(email);
  if (userId === null) throw missing();
  const rows = await getDb()
    .select({
      id: projects.id,
      name: projects.name,
      ownerId: projects.ownerId,
      isDefault: projects.isDefault,
      role: projectMembers.role,
    })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(and(eq(projects.id, projectId), eq(projectMembers.userId, userId)));
  const row = rows[0];
  if (row === undefined) throw missing();
  return {
    userId,
    projectId: row.id,
    ownerId: row.ownerId,
    isDefault: row.isDefault,
    name: row.name,
    role: row.role,
  };
}

export async function projectIdOrThrow(
  email: string,
  projectId: string,
): Promise<string> {
  return (await memberAccessOrThrow(email, projectId)).projectId;
}

async function addMemberRow(
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<void> {
  await getDb()
    .insert(projectMembers)
    .values({ id: newId(), projectId, userId, role })
    .onConflictDoNothing();
}

export async function ensureDefaultProject(userId: string): Promise<string> {
  const existing = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.ownerId, userId), eq(projects.isDefault, true)));
  const found = existing[0];
  if (found !== undefined) return found.id;
  const id = newId();
  await getDb()
    .insert(projects)
    .values({ id, name: 'Personal', ownerId: userId, isDefault: true });
  await addMemberRow(id, userId, 'admin');
  return id;
}

export async function ensureUserWithProject(rawEmail: string): Promise<string> {
  const userId = await ensureUser(rawEmail);
  await ensureDefaultProject(userId);
  return userId;
}

export async function listProjectsForEmail(email: string): Promise<Project[]> {
  const userId = await userIdForEmail(email);
  if (userId === null) return [];
  const rows = await getDb()
    .select({
      id: projects.id,
      name: projects.name,
      isDefault: projects.isDefault,
      ownerId: projects.ownerId,
      role: projectMembers.role,
    })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, userId))
    .orderBy(asc(projects.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isDefault: r.isDefault,
    owner: r.ownerId === userId,
    role: r.role,
  }));
}

export async function createProjectForEmail(
  email: string,
  raw: unknown,
): Promise<Project> {
  const name = projectName(raw);
  const userId = await ensureUser(email);
  const id = newId();
  await getDb().insert(projects).values({ id, name, ownerId: userId });
  await addMemberRow(id, userId, 'admin');
  return { id, name, isDefault: false, owner: true, role: 'admin' };
}

export async function renameProjectForEmail(
  email: string,
  projectId: string,
  raw: unknown,
): Promise<Project> {
  const name = projectName(raw);
  const access = await memberAccessOrThrow(email, projectId);
  if (access.role !== 'admin')
    throw forbidden('only an admin can rename a project');
  await getDb()
    .update(projects)
    .set({ name })
    .where(eq(projects.id, access.projectId));
  return {
    id: access.projectId,
    name,
    isDefault: access.isDefault,
    owner: access.ownerId === access.userId,
    role: access.role,
  };
}

export async function deleteProjectForEmail(
  email: string,
  projectId: string,
): Promise<{ id: string; name: string }> {
  const access = await memberAccessOrThrow(email, projectId);
  if (access.ownerId !== access.userId)
    throw forbidden('only the owner can delete a project');
  if (access.isDefault)
    throw forbidden('your default project cannot be deleted');
  try {
    await getDb().delete(projects).where(eq(projects.id, access.projectId));
  } catch {
    throw new ProjectError(
      'this project still holds agents or connectors',
      409,
    );
  }
  return { id: access.projectId, name: access.name };
}

export async function listMembersForEmail(
  email: string,
  projectId: string,
): Promise<Member[]> {
  const access = await memberAccessOrThrow(email, projectId);
  const rows = await getDb()
    .select({
      id: projectMembers.id,
      email: users.email,
      role: projectMembers.role,
      userId: projectMembers.userId,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, access.projectId))
    .orderBy(asc(projectMembers.id));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    owner: r.userId === access.ownerId,
  }));
}

function readRole(raw: unknown): ProjectRole {
  if (raw === 'admin' || raw === 'member') return raw;
  throw new ProjectError("a role is 'admin' or 'member'", 400);
}

async function adminAccessOrThrow(
  email: string,
  projectId: string,
): Promise<Access> {
  const access = await memberAccessOrThrow(email, projectId);
  if (access.role !== 'admin')
    throw forbidden('only an admin can manage members');
  return access;
}

export async function addMemberForEmail(
  email: string,
  projectId: string,
  raw: unknown,
  rawRole: unknown,
): Promise<Member[]> {
  const access = await adminAccessOrThrow(email, projectId);
  const role = readRole(rawRole);
  const invited = normalizeEmail(typeof raw === 'string' ? raw : '');
  if (invited === '') throw new ProjectError('an email is required', 400);
  const invitedId = await ensureUser(invited);
  await ensureDefaultProject(invitedId);
  await addMemberRow(access.projectId, invitedId, role);
  return listMembersForEmail(email, projectId);
}

async function memberRowOrThrow(
  projectId: string,
  memberId: string,
): Promise<{ userId: string }> {
  const rows = await getDb()
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.id, memberId),
        eq(projectMembers.projectId, projectId),
      ),
    );
  const row = rows[0];
  if (row === undefined) throw new ProjectError('no such member', 404);
  return row;
}

export async function setMemberRoleForEmail(
  email: string,
  projectId: string,
  memberId: string,
  rawRole: unknown,
): Promise<Member[]> {
  const access = await adminAccessOrThrow(email, projectId);
  const role = readRole(rawRole);
  const member = await memberRowOrThrow(access.projectId, memberId);
  if (member.userId === access.ownerId)
    throw forbidden('the owner is always an admin');
  await getDb()
    .update(projectMembers)
    .set({ role })
    .where(eq(projectMembers.id, memberId));
  return listMembersForEmail(email, projectId);
}

export async function removeMemberForEmail(
  email: string,
  projectId: string,
  memberId: string,
): Promise<Member[]> {
  const access = await adminAccessOrThrow(email, projectId);
  const member = await memberRowOrThrow(access.projectId, memberId);
  if (member.userId === access.ownerId)
    throw forbidden('the owner cannot be removed from their own project');
  await getDb().delete(projectMembers).where(eq(projectMembers.id, memberId));
  return listMembersForEmail(email, projectId);
}
