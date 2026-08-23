import { ownedAgentOrThrow } from './agent-admin.js';
import { ApiError } from '../daemon/api-error.js';
import { mintRunCode } from '../daemon/run-pair.js';
import { loadAllStationsFor, unmovableStations } from './materialize.js';
import { releaseRuntime } from './runtimes.js';

export async function mintRuntimeCodeForEmail(
  email: string,
  agentId: string,
): Promise<{ code: string; expiresAt: number }> {
  const { agent } = await ownedAgentOrThrow(email, agentId);
  const blocked = unmovableStations(await loadAllStationsFor(agent.id));
  if (blocked.length > 0)
    throw new ApiError(
      `'${agent.name}' holds ${blocked.join(', ')}, which only runs on metro ` +
        'because a webhook url has to be publicly reachable. Its deliveries ' +
        'would arrive at metro while this agent listens on your machine, so ' +
        'they would be dropped. Detach it, or attach it to a second agent that ' +
        'stays on metro, then authorize this one.',
      409,
    );
  return mintRunCode({ email, agentId: agent.id });
}

export async function releaseRuntimeForEmail(
  email: string,
  agentId: string,
): Promise<void> {
  const { agent } = await ownedAgentOrThrow(email, agentId);
  await releaseRuntime(agent.id);
}
