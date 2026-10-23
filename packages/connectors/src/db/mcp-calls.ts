import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from './database.js';
import { agents, connectors, mcpCalls } from './schema.js';
import { callStats, connectorGroup, type CallStats, type StatsScope } from './mcp-call-stats.js';

export type McpCallRow = typeof mcpCalls.$inferSelect;

export type NewMcpCall = Omit<McpCallRow, 'agentName'>;

export const CALLS_PAGE = 50;
export const CALLS_PAGE_MAX = 200;
export const CALL_NAME_MAX = 256;

export interface CallCursor {
  at: number;
  id?: string;
}

export interface CallFilter {
  limit: number;
  since?: number;
  before?: CallCursor;
  agent?: string;
  connector?: string;
}

export interface CallView {
  id: string;
  agent: string;
  agentName: string | null;
  connector: string | null;
  connectorKey: string;
  connectorName: string | null;
  connectorUrl: string | null;
  tool: string;
  outcome: string;
  ms: number;
  at: number;
}

export interface McpCallStore {
  recent: (owner: string, filter: CallFilter) => Promise<CallView[]>;
  stats: (scope: StatsScope) => Promise<CallStats>;
}

export async function recordCall(db: Database, row: NewMcpCall): Promise<void> {
  const agentName = sql<string | null>`(select left(coalesce(${agents.name}, ${agents.host}), ${CALL_NAME_MAX}) from ${agents} where ${agents.id} = ${row.agent} and ${agents.owner} = ${row.owner})`;
  await db.insert(mcpCalls).values({ ...row, agentName });
}

function beforeOf(cursor: CallCursor | undefined): SQL | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.id === undefined) return lt(mcpCalls.at, cursor.at);
  return sql`(${mcpCalls.at}, ${mcpCalls.id}) < (${cursor.at}, ${cursor.id})`;
}

export async function recentCalls(db: Database, owner: string, filter: CallFilter): Promise<CallView[]> {
  const limit = Math.min(Math.max(1, Math.floor(filter.limit)), CALLS_PAGE_MAX);
  const scope = and(
    eq(mcpCalls.owner, owner),
    filter.since === undefined ? undefined : gte(mcpCalls.at, filter.since),
    beforeOf(filter.before),
    filter.agent === undefined ? undefined : eq(mcpCalls.agent, filter.agent),
    filter.connector === undefined ? undefined : sql`${connectorGroup} = ${filter.connector}`,
  );
  return db
    .select({
      id: mcpCalls.id,
      agent: mcpCalls.agent,
      agentName: sql<string | null>`coalesce(${agents.name}, ${agents.host}, ${mcpCalls.agentName})`,
      connector: mcpCalls.connector,
      connectorKey: mcpCalls.connectorKey,
      connectorName: sql<string | null>`coalesce(${connectors.name}, ${mcpCalls.connectorName})`,
      connectorUrl: connectors.url,
      tool: mcpCalls.tool,
      outcome: mcpCalls.outcome,
      ms: mcpCalls.ms,
      at: mcpCalls.at,
    })
    .from(mcpCalls)
    .leftJoin(agents, and(eq(agents.id, mcpCalls.agent), eq(agents.owner, owner)))
    .leftJoin(connectors, and(eq(connectors.id, mcpCalls.connector), eq(connectors.owner, owner)))
    .where(scope)
    .orderBy(desc(mcpCalls.at), desc(mcpCalls.id))
    .limit(limit);
}

export function mcpCallStore(db: () => Database): McpCallStore {
  return { recent: (owner, filter) => recentCalls(db(), owner, filter), stats: (scope) => callStats(db(), scope) };
}
