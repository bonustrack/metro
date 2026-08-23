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
      `'${agent.name}' cannot run locally while it holds ${blocked.join(', ')} — ` +
        'those stations only run on metro. Move them to another agent first.',
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
