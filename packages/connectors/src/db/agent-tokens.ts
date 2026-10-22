import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './database.js';
import { agents, agentTokens } from './schema.js';

export const AGENT_TOKENS_MAX = 20;
export const TOKEN_LABEL_MAX = 64;

export type AgentTokenRow = typeof agentTokens.$inferSelect;

export interface AgentTokenIdentity {
  agent: string;
  owner: string;
  tokenId: string;
}

export interface NewAgentToken {
  owner: string;
  agent: string;
  label: string;
  createdBy: string;
  now: number;
}

export const tokenHashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('base64url');

export const newAgentToken = (): string => `mcp_${randomBytes(32).toString('base64url')}`;

export const isTokenIdentity = (identity: { agent: string; owner: string }): identity is AgentTokenIdentity => 'tokenId' in identity;

const missingAgent = (): ApiError => new ApiError('no such agent', 404);

async function remoteAgentIn(tx: Database, owner: string, agent: string): Promise<void> {
  const rows = await tx.select({ kind: agents.kind }).from(agents).where(and(eq(agents.id, agent), eq(agents.owner, owner))).for('update');
  const row = rows[0];
  if (row === undefined) throw missingAgent();
  if (row.kind !== 'remote') throw new ApiError('Access keys are for agents without a server. This agent reaches its connectors through its own server.', 409);
}

async function createIn(tx: Database, input: NewAgentToken): Promise<{ row: AgentTokenRow; token: string }> {
  await remoteAgentIn(tx, input.owner, input.agent);
  const live = await tx.$count(agentTokens, and(eq(agentTokens.agent, input.agent), eq(agentTokens.owner, input.owner), isNull(agentTokens.revokedAt)));
  if (live >= AGENT_TOKENS_MAX) throw new ApiError(`This agent already has ${String(AGENT_TOKENS_MAX)} access keys. Revoke one first.`, 409);
  const token = newAgentToken();
  const row: AgentTokenRow = { id: newId(), owner: input.owner, agent: input.agent, label: input.label, tokenHash: tokenHashOf(token), createdBy: input.createdBy, createdAt: input.now, lastUsedAt: null, revokedAt: null };
  await tx.insert(agentTokens).values(row);
  return { row, token };
}

export function createAgentToken(db: Database, input: NewAgentToken): Promise<{ row: AgentTokenRow; token: string }> {
  return db.transaction((tx) => createIn(tx, input));
}

export async function listAgentTokens(db: Database, owner: string, agent: string): Promise<AgentTokenRow[]> {
  return db.select().from(agentTokens).where(and(eq(agentTokens.agent, agent), eq(agentTokens.owner, owner))).orderBy(desc(agentTokens.createdAt), desc(agentTokens.id));
}

export async function revokeAgentToken(db: Database, owner: string, agent: string, id: string, now: number): Promise<AgentTokenRow> {
  const mine = and(eq(agentTokens.id, id), eq(agentTokens.agent, agent), eq(agentTokens.owner, owner));
  const revoked = await db.update(agentTokens).set({ revokedAt: now }).where(and(mine, isNull(agentTokens.revokedAt))).returning();
  if (revoked[0] !== undefined) return revoked[0];
  const held = await db.select().from(agentTokens).where(mine).limit(1);
  if (held[0] === undefined) throw new ApiError('no such access key', 404);
  return held[0];
}

export async function findAgentToken(db: Database, tokenHash: string): Promise<AgentTokenIdentity | null> {
  const rows = await db
    .select({ agent: agentTokens.agent, owner: agentTokens.owner, tokenId: agentTokens.id })
    .from(agentTokens)
    .innerJoin(agents, and(eq(agents.id, agentTokens.agent), eq(agents.owner, agentTokens.owner)))
    .where(and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchAgentToken(db: Database, id: string, now: number): Promise<void> {
  await db.update(agentTokens).set({ lastUsedAt: now }).where(eq(agentTokens.id, id));
}
