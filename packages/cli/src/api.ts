import { localAgent, localDaemonUp } from './local.js';
import { localUrl } from './runtime.js';

const NO_DAEMON = `no metro daemon on ${localUrl()} — start one with: metro serve`;

export async function whoisAuthorized(): Promise<{ agent: string; where: string }> {
  if (!(await localDaemonUp())) throw new Error(NO_DAEMON);
  const agent = localAgent();
  if (agent === null) throw new Error('no agent on this machine yet');
  return { agent: agent.id, where: localUrl() };
}
