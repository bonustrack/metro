import { ownedAgentOrThrow } from './agent-admin.js';
import { mintAgentCode } from '../daemon/agent-pair.js';
import { loadAllStationsFor, unmovableStations } from './materialize.js';
import { releaseRuntime } from './runtimes.js';

export async function mintAgentCodeForEmail(
  email: string,
  agentId: string,
): Promise<{ code: string; expiresAt: number; agent: string }> {
  const { agent } = await ownedAgentOrThrow(email, agentId);
  return { ...mintAgentCode({ email, agentId: agent.id }), agent: agent.name };
}

export async function blockedStationsFor(agentId: string): Promise<string[]> {
  return unmovableStations(await loadAllStationsFor(agentId));
}

export async function releaseRuntimeForEmail(
  email: string,
  agentId: string,
): Promise<void> {
  const { agent } = await ownedAgentOrThrow(email, agentId);
  await releaseRuntime(agent.id);
}
