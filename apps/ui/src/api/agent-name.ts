import { serverLabel } from './servers.js';
import { useServersQuery } from './queries.js';
import { currentServer } from '../auth/daemon.js';

export function useAgentName(): string {
  const { data } = useServersQuery();
  const here = currentServer();
  const server = data?.find((s) => s.id === here?.id);
  return server === undefined ? 'the agent' : serverLabel(server);
}
