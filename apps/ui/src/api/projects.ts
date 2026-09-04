import { call } from './client';
import { isRecord } from './accounts';

export interface Project {
  id: string;
  name: string;
}

function toProject(value: unknown): Project {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return { id: value.id, name: value.name };
}

export async function fetchProjects(token: string, daemon: string): Promise<Project[]> {
  const body = await call(token, { base: `${daemon}/api/projects`, method: 'GET' });
  if (!isRecord(body) || !Array.isArray(body.projects))
    throw new Error('Metro returned an unexpected response.');
  return body.projects.map(toProject);
}
