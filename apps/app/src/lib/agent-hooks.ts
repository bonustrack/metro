import { serverLabel } from '@metro-labs/client/api/servers';
import { pickHomeProject } from '@metro-labs/client/api/claude';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { useClaudeProjectsQuery, useServersQuery } from './queries.js';

export function useAgentName(): string {
  const { data } = useServersQuery();
  const here = currentServer();
  const server = data?.find((s) => s.id === here?.id);
  return server === undefined ? 'the agent' : serverLabel(server);
}

export interface HomeProject {
  loading: boolean;
  project: string | null;
}

export function useHomeProject(): HomeProject {
  const { data } = useClaudeProjectsQuery();
  if (data === undefined) return { loading: true, project: null };
  return { loading: false, project: pickHomeProject(data) };
}
