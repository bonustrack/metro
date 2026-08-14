import { and, desc, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { agentRuns, type RunState } from './schema.js';

export interface AgentRunInput {
  runId: string;
  agentType: string | null;
  label: string | null;
  state: RunState;
  startedAt: Date;
  endedAt: Date | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRunRow extends AgentRunInput {
  agentId: number;
}

const excluded = {
  agentType: sql`excluded."agent_type"`,
  label: sql`excluded."label"`,
  state: sql`excluded."state"`,
  startedAt: sql`excluded."started_at"`,
  endedAt: sql`excluded."ended_at"`,
  turns: sql`excluded."turns"`,
  inputTokens: sql`excluded."input_tokens"`,
  outputTokens: sql`excluded."output_tokens"`,
  cacheReadTokens: sql`excluded."cache_read_tokens"`,
  cacheWriteTokens: sql`excluded."cache_write_tokens"`,
  updatedAt: sql`now()`,
};

export async function recordAgentRuns(
  agentId: number,
  runs: AgentRunInput[],
): Promise<number> {
  if (runs.length === 0) return 0;
  await getDb()
    .insert(agentRuns)
    .values(runs.map((run) => ({ ...run, agentId })))
    .onConflictDoUpdate({
      target: [agentRuns.agentId, agentRuns.runId],
      set: excluded,
    });
  return runs.length;
}

export async function listAgentRuns(
  allowed: Set<number>,
  sinceMs: number,
  limit: number,
): Promise<AgentRunRow[]> {
  if (allowed.size === 0) return [];
  return getDb()
    .select({
      agentId: agentRuns.agentId,
      runId: agentRuns.runId,
      agentType: agentRuns.agentType,
      label: agentRuns.label,
      state: agentRuns.state,
      startedAt: agentRuns.startedAt,
      endedAt: agentRuns.endedAt,
      turns: agentRuns.turns,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      cacheReadTokens: agentRuns.cacheReadTokens,
      cacheWriteTokens: agentRuns.cacheWriteTokens,
    })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.agentId, [...allowed]),
        gte(agentRuns.startedAt, new Date(Date.now() - sinceMs)),
      ),
    )
    .orderBy(desc(agentRuns.startedAt))
    .limit(limit);
}
