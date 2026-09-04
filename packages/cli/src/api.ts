import { localAgents, localDaemonUp, localMcpServers, pickLocalAgent } from './local.js';
import { localUrl } from './runtime.js';

const NO_DAEMON = `no metro daemon on ${localUrl()} — start one with: metro serve`;

export async function mcpServers(wanted?: string): Promise<string> {
  if (!(await localDaemonUp())) throw new Error(NO_DAEMON);
  return localMcpServers(pickLocalAgent(localAgents(), wanted));
}

export async function whoisAuthorized(wanted?: string): Promise<{ agent: string; where: string }> {
  if (!(await localDaemonUp())) throw new Error(NO_DAEMON);
  const agent = pickLocalAgent(localAgents(), wanted);
  return { agent: agent.name, where: localUrl() };
}
