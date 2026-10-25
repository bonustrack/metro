import { and, eq, gte, inArray, lt, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Database } from './database.js';
import { agents, modelCalls, modelConnections } from './schema.js';

export const MODEL_OUTCOMES = {
  failed: ['provider_error', 'refused', 'no_route'],
  limited: ['rate_limited'],
} as const;

export interface ModelStatsScope {
  owner: string;
  from: number;
  to: number;
  bucketMs: number;
  agent?: string;
  connection?: string;
}

export interface ModelSlot {
  slot: number;
  connection: string;
  calls: number;
  failed: number;
  spendMicros: number;
}

export interface ConnectionUsage {
  connection: string;
  provider: string | null;
  label: string | null;
  calls: number;
  failed: number;
  spendMicros: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentUsage {
  agent: string;
  name: string | null;
  calls: number;
  spendMicros: number;
}

export interface ModelTotals {
  calls: number;
  ok: number;
  failed: number;
  limited: number;
  spendMicros: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  p50FirstTokenMs: number | null;
  p95FirstTokenMs: number | null;
}

export interface ModelStats {
  slots: ModelSlot[];
  connections: ConnectionUsage[];
  agents: AgentUsage[];
  totals: ModelTotals;
}

export interface ModelUsageStore {
  stats: (scope: ModelStatsScope) => Promise<ModelStats>;
}

const NO_CONNECTION = '';

const connectionGroup = sql<string>`coalesce(${modelCalls.connection}, ${NO_CONNECTION})`;

const whole = (expression: SQL): SQL<number> => sql<number>`(${expression})::float8`;

const ALL = whole(sql`count(*)`);

const counted = (outcomes: readonly string[]): SQL<number> => whole(sql`count(*) filter (where ${inArray(modelCalls.outcome, [...outcomes])})`);

const summed = (column: SQLWrapper): SQL<number> => whole(sql`coalesce(sum(${column}), 0)`);

const SPEND = summed(sql`${modelCalls.costMicros}`);

const UNPRICED = whole(sql`count(*) filter (where ${modelCalls.costMicros} is null and ${eq(modelCalls.outcome, 'ok')})`);

const CACHE_WRITE = summed(sql`${modelCalls.cacheWrite5mTokens} + ${modelCalls.cacheWrite1hTokens}`);

const firstToken = (share: number): SQL<number | null> =>
  sql<number | null>`round(percentile_cont(${sql.raw(String(share))}) within group (order by ${modelCalls.firstTokenMs}) filter (where ${eq(modelCalls.outcome, 'ok')} and ${modelCalls.firstTokenMs} is not null))::int`;

function scopeOf(scope: ModelStatsScope): SQL | undefined {
  return and(
    eq(modelCalls.owner, scope.owner),
    gte(modelCalls.at, scope.from),
    lt(modelCalls.at, scope.to),
    scope.agent === undefined ? undefined : eq(modelCalls.agent, scope.agent),
    scope.connection === undefined ? undefined : sql`${connectionGroup} = ${scope.connection}`,
  );
}

function slotsOf(db: Database, scope: ModelStatsScope): Promise<ModelSlot[]> {
  const slot = whole(sql`(${modelCalls.at} - ${scope.from}::bigint) / ${scope.bucketMs}::bigint`);
  return db
    .select({ slot, connection: connectionGroup, calls: ALL, failed: counted(MODEL_OUTCOMES.failed), spendMicros: SPEND })
    .from(modelCalls)
    .where(scopeOf(scope))
    .groupBy(sql`1`, sql`2`);
}

function connectionsOf(db: Database, scope: ModelStatsScope): Promise<ConnectionUsage[]> {
  return db
    .select({
      connection: connectionGroup,
      provider: sql<string | null>`max(${modelCalls.provider})`,
      label: sql<string | null>`max(${modelConnections.label})`,
      calls: ALL,
      failed: counted(MODEL_OUTCOMES.failed),
      spendMicros: SPEND,
      unpriced: UNPRICED,
      inputTokens: summed(modelCalls.inputTokens),
      outputTokens: summed(modelCalls.outputTokens),
      cacheReadTokens: summed(modelCalls.cacheReadTokens),
      cacheWriteTokens: CACHE_WRITE,
    })
    .from(modelCalls)
    .leftJoin(modelConnections, and(eq(modelConnections.id, modelCalls.connection), eq(modelConnections.owner, scope.owner)))
    .where(scopeOf(scope))
    .groupBy(sql`1`);
}

function agentsOf(db: Database, scope: ModelStatsScope): Promise<AgentUsage[]> {
  return db
    .select({
      agent: modelCalls.agent,
      name: sql<string | null>`coalesce(max(coalesce(${agents.name}, ${agents.host})), (array_agg(${modelCalls.agentName} order by ${modelCalls.at} desc) filter (where ${modelCalls.agentName} is not null))[1])`,
      calls: ALL,
      spendMicros: SPEND,
    })
    .from(modelCalls)
    .leftJoin(agents, and(eq(agents.id, modelCalls.agent), eq(agents.owner, scope.owner)))
    .where(scopeOf(scope))
    .groupBy(modelCalls.agent);
}

const NO_TOTALS: ModelTotals = { calls: 0, ok: 0, failed: 0, limited: 0, spendMicros: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, p50FirstTokenMs: null, p95FirstTokenMs: null };

async function totalsOf(db: Database, scope: ModelStatsScope): Promise<ModelTotals> {
  const rows = await db
    .select({
      calls: ALL,
      ok: counted(['ok']),
      failed: counted(MODEL_OUTCOMES.failed),
      limited: counted(MODEL_OUTCOMES.limited),
      spendMicros: SPEND,
      unpriced: UNPRICED,
      inputTokens: summed(modelCalls.inputTokens),
      outputTokens: summed(modelCalls.outputTokens),
      cacheReadTokens: summed(modelCalls.cacheReadTokens),
      cacheWriteTokens: CACHE_WRITE,
      p50FirstTokenMs: firstToken(0.5),
      p95FirstTokenMs: firstToken(0.95),
    })
    .from(modelCalls)
    .where(scopeOf(scope));
  return rows[0] ?? NO_TOTALS;
}

export async function modelStats(db: Database, scope: ModelStatsScope): Promise<ModelStats> {
  const [slots, connections, agentRows, totals] = await Promise.all([slotsOf(db, scope), connectionsOf(db, scope), agentsOf(db, scope), totalsOf(db, scope)]);
  return { slots, connections, agents: agentRows, totals };
}

export const modelUsageStore = (db: () => Database): ModelUsageStore => ({ stats: (scope) => modelStats(db(), scope) });
