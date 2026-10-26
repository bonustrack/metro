import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from './database.js';
import { connectors, mcpCalls } from './schema.js';

const CALL_OUTCOMES = {
  failed: ['vendor_error', 'unavailable', 'invalid', 'signin', 'not_found'],
  blocked: ['blocked', 'denied'],
  waiting: ['needs_approval'],
  timed: ['ok', 'vendor_error', 'unavailable'],
} as const;

export interface StatsScope {
  owner: string;
  from: number;
  to: number;
  bucketMs: number;
  agent?: string;
  connector?: string;
}

interface SlotCount {
  slot: number;
  group: string;
  total: number;
  failed: number;
}

export interface GroupCount {
  group: string;
  connector: string | null;
  key: string;
  current: string | null;
  stored: string | null;
  url: string | null;
  total: number;
  failed: number;
}

export interface CallTotals {
  total: number;
  ok: number;
  failed: number;
  blocked: number;
  denied: number;
  waiting: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface CallStats {
  slots: SlotCount[];
  groups: GroupCount[];
  totals: CallTotals;
}

export const connectorGroup = sql<string>`coalesce(${mcpCalls.connector}, ${mcpCalls.connectorKey})`;

const whole = (expression: SQL): SQL<number> => sql<number>`(${expression})::int`;

const counted = (outcomes: readonly string[]): SQL<number> => whole(sql`count(*) filter (where ${inArray(mcpCalls.outcome, [...outcomes])})`);

const ALL = whole(sql`count(*)`);

const percentile = (share: number): SQL<number | null> =>
  sql<number | null>`round(percentile_cont(${sql.raw(String(share))}) within group (order by ${mcpCalls.ms}) filter (where ${inArray(mcpCalls.outcome, [...CALL_OUTCOMES.timed])}))::int`;

function scopeOf(scope: StatsScope): SQL | undefined {
  return and(
    eq(mcpCalls.owner, scope.owner),
    gte(mcpCalls.at, scope.from),
    lt(mcpCalls.at, scope.to),
    scope.agent === undefined ? undefined : eq(mcpCalls.agent, scope.agent),
    scope.connector === undefined ? undefined : sql`${connectorGroup} = ${scope.connector}`,
  );
}

function slotCounts(db: Database, scope: StatsScope): Promise<SlotCount[]> {
  const slot = whole(sql`(${mcpCalls.at} - ${scope.from}::bigint) / ${scope.bucketMs}::bigint`);
  return db
    .select({ slot, group: connectorGroup, total: ALL, failed: counted(CALL_OUTCOMES.failed) })
    .from(mcpCalls)
    .where(scopeOf(scope))
    .groupBy(sql`1`, sql`2`);
}

function groupCounts(db: Database, scope: StatsScope): Promise<GroupCount[]> {
  return db
    .select({
      group: connectorGroup,
      connector: sql<string | null>`max(${mcpCalls.connector})`,
      key: sql<string>`(array_agg(${mcpCalls.connectorKey} order by ${mcpCalls.at} desc))[1]`,
      current: sql<string | null>`max(${connectors.name})`,
      stored: sql<string | null>`(array_agg(${mcpCalls.connectorName} order by ${mcpCalls.at} desc) filter (where ${mcpCalls.connectorName} is not null))[1]`,
      url: sql<string | null>`max(${connectors.url})`,
      total: ALL,
      failed: counted(CALL_OUTCOMES.failed),
    })
    .from(mcpCalls)
    .leftJoin(connectors, and(eq(connectors.id, mcpCalls.connector), eq(connectors.owner, scope.owner)))
    .where(scopeOf(scope))
    .groupBy(sql`1`);
}

async function totalsOf(db: Database, scope: StatsScope): Promise<CallTotals> {
  const [row] = await db
    .select({
      total: ALL,
      ok: counted(['ok']),
      failed: counted(CALL_OUTCOMES.failed),
      blocked: counted(CALL_OUTCOMES.blocked),
      denied: counted(['denied']),
      waiting: counted(CALL_OUTCOMES.waiting),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
    })
    .from(mcpCalls)
    .where(scopeOf(scope));
  return row ?? { total: 0, ok: 0, failed: 0, blocked: 0, denied: 0, waiting: 0, p50Ms: null, p95Ms: null };
}

export async function callStats(db: Database, scope: StatsScope): Promise<CallStats> {
  const [slots, groups, totals] = await Promise.all([slotCounts(db, scope), groupCounts(db, scope), totalsOf(db, scope)]);
  return { slots, groups, totals };
}
