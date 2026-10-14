import { and, eq, lt } from 'drizzle-orm';
import { AGENT_CLOCK_SKEW_MS, withinSkew, type AgentProof } from '@metro-labs/http/agent-signature';
import { AGENT_NONCE_LIMITS, AgentAuthError, notEnrolled, type NonceLimits } from '../agent-auth.js';
import type { Database } from './database.js';
import { agentNonceGuard, agentNonces } from './schema.js';

export interface AgentNonceStore {
  consume: (proof: AgentProof, owner: string) => Promise<void>;
}

async function consumeIn(tx: Database, proof: AgentProof, owner: string, now: () => number, limits: NonceLimits): Promise<void> {
  const guard = await tx.select().from(agentNonceGuard).where(eq(agentNonceGuard.id, 'requests')).for('update');
  if (guard.length !== 1) throw new AgentAuthError('Metro cannot check agent requests yet.', 503);
  const time = now();
  if (!withinSkew(proof.time, time)) throw notEnrolled();
  await tx.delete(agentNonces).where(lt(agentNonces.expiresAt, time));
  const replay = await tx.select({ nonce: agentNonces.nonce }).from(agentNonces).where(and(eq(agentNonces.keyId, proof.keyId), eq(agentNonces.nonce, proof.nonce))).limit(1);
  if (replay.length > 0) throw notEnrolled();
  if (await tx.$count(agentNonces, eq(agentNonces.keyId, proof.keyId)) >= limits.perKey) throw new AgentAuthError('This agent sent too many requests. Wait a few minutes, then try again.', 429);
  if (await tx.$count(agentNonces, eq(agentNonces.owner, owner)) >= limits.perOwner) throw new AgentAuthError('The agents of this organization sent too many requests. Wait a few minutes, then try again.', 429);
  if (await tx.$count(agentNonces) >= limits.total) throw new AgentAuthError('Metro is busy checking agent requests. Try again in a few minutes.', 503);
  await tx.insert(agentNonces).values({ keyId: proof.keyId, nonce: proof.nonce, owner, expiresAt: proof.time + AGENT_CLOCK_SKEW_MS });
}

export function agentNonceStore(db: () => Database, now: () => number, limits: NonceLimits = AGENT_NONCE_LIMITS): AgentNonceStore {
  return { consume: (proof, owner) => db().transaction((tx) => consumeIn(tx, proof, owner, now, limits)) };
}
