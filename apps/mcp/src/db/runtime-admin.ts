import { ownedAgentOrThrow } from './agent-admin.js';
import { mintAgentCode } from '../daemon/agent-pair.js';
import { loadAllStationsFor, unmovableStations } from './materialize.js';
import { releaseRuntime } from './runtimes.js';

export async function mintAgentCodeForUser(
  subject: string,
  agentId: string,
): Promise<{ code: string; expiresAt: number; agent: string }> {
  const { agent } = await ownedAgentOrThrow(subject, agentId);
  return { ...mintAgentCode({ subject, agentId: agent.id }), agent: agent.name };
}

export async function blockedStationsFor(agentId: string): Promise<string[]> {
  return unmovableStations(await loadAllStationsFor(agentId));
}

export async function releaseRuntimeForUser(
  subject: string,
  agentId: string,
): Promise<void> {
  const { agent } = await ownedAgentOrThrow(subject, agentId);
  await releaseRuntime(agent.id);
}
