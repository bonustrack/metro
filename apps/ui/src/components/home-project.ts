import { useClaudeProjectsQuery } from '../api/queries.js';
import type { ClaudeProject } from '../api/claude.js';

export interface HomeProject {
  loading: boolean;
  project: string | null;
}

export function pickHomeProject(projects: ClaudeProject[]): string | null {
  let best: ClaudeProject | null = null;
  for (const project of projects) {
    if (best === null || (project.lastActiveAt ?? '') > (best.lastActiveAt ?? '')) best = project;
  }
  return best?.id ?? null;
}

export function useHomeProject(): HomeProject {
  const { data } = useClaudeProjectsQuery();
  if (data === undefined) return { loading: true, project: null };
  return { loading: false, project: pickHomeProject(data) };
}
