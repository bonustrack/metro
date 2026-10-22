import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
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
  remote: boolean;
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

async function agentIn(tx: Database, owner: string, agent: string): Promise<void> {
  const rows = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agent), eq(agents.owner, owner))).for('update');
  if (rows[0] === undefined) throw missingAgent();
}

async function createIn(tx: Database, input: NewAgentToken): Promise<{ row: AgentTokenRow; token: string }> {
  await agentIn(tx, input.owner, input.agent);
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
    .select({ agent: agentTokens.agent, owner: agentTokens.owner, tokenId: agentTokens.id, kind: agents.kind })
    .from(agentTokens)
    .innerJoin(agents, and(eq(agents.id, agentTokens.agent), eq(agents.owner, agentTokens.owner)))
    .where(and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { agent: row.agent, owner: row.owner, tokenId: row.tokenId, remote: row.kind === 'remote' };
}

export async function agentTokenLabels(db: Database, identity: { agent: string; owner: string }, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: agentTokens.id, label: agentTokens.label })
    .from(agentTokens)
    .where(and(inArray(agentTokens.id, ids), eq(agentTokens.agent, identity.agent), eq(agentTokens.owner, identity.owner)));
  return new Map(rows.map((row) => [row.id, row.label]));
}

export async function touchAgentToken(db: Database, id: string, now: number): Promise<void> {
  await db.update(agentTokens).set({ lastUsedAt: now }).where(eq(agentTokens.id, id));
}
