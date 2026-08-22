import { call } from './client';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/session';

export type ProjectRole = 'admin' | 'member';

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

const projectsUrl = (): string => `${daemonBase()}/api/projects`;

const json = (
  body: unknown,
): { headers: Record<string, string>; body: string } => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function toRole(value: unknown): ProjectRole {
  return value === 'admin' ? 'admin' : 'member';
}

function toProject(value: unknown): Project {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return {
    id: value.id,
    name: value.name,
    isDefault: value.isDefault === true,
    owner: value.owner === true,
    role: toRole(value.role),
  };
}

function toMember(value: unknown): Member {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.email !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return {
    id: value.id,
    email: value.email,
    role: toRole(value.role),
    owner: value.owner === true,
  };
}

function membersOf(body: unknown): Member[] {
  if (!isRecord(body) || !Array.isArray(body.members))
    throw new Error('Metro returned an unexpected response.');
  return body.members.map(toMember);
}

export async function fetchProjects(token: string): Promise<Project[]> {
  const body = await call(token, { base: projectsUrl(), method: 'GET' });
  if (!isRecord(body) || !Array.isArray(body.projects))
    throw new Error('Metro returned an unexpected response.');
  return body.projects.map(toProject);
}

export async function createProject(
  token: string,
  name: string,
): Promise<Project> {
  return toProject(
    await call(token, { base: projectsUrl(), method: 'POST', ...json({ name }) }),
  );
}

export async function renameProject(
  token: string,
  id: string,
  name: string,
): Promise<Project> {
  return toProject(
    await call(token, {
      base: projectsUrl(),
      method: 'POST',
      path: `/${id}/rename`,
      ...json({ name }),
    }),
  );
}

export async function deleteProject(token: string, id: string): Promise<void> {
  await call(token, { base: projectsUrl(), method: 'DELETE', path: `/${id}` });
}

export async function fetchMembers(
  token: string,
  id: string,
): Promise<Member[]> {
  return membersOf(
    await call(token, {
      base: projectsUrl(),
      method: 'GET',
      path: `/${id}/members`,
    }),
  );
}

export async function addMember(
  token: string,
  id: string,
  email: string,
  role: ProjectRole,
): Promise<Member[]> {
  return membersOf(
    await call(token, {
      base: projectsUrl(),
      method: 'POST',
      path: `/${id}/members`,
      ...json({ email, role }),
    }),
  );
}

export async function setMemberRole(
  token: string,
  id: string,
  memberId: string,
  role: ProjectRole,
): Promise<Member[]> {
  return membersOf(
    await call(token, {
      base: projectsUrl(),
      method: 'POST',
      path: `/${id}/members/${memberId}`,
      ...json({ role }),
    }),
  );
}

export async function removeMember(
  token: string,
  id: string,
  memberId: string,
): Promise<Member[]> {
  return membersOf(
    await call(token, {
      base: projectsUrl(),
      method: 'DELETE',
      path: `/${id}/members/${memberId}`,
    }),
  );
}
