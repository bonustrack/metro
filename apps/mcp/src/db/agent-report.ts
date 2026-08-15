import { inArray, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { agentReports, type ReportRow } from './schema.js';

export interface AgentReportRow {
  agentId: number;
  rows: ReportRow[];
  reportedAt: Date;
}

export async function recordAgentReport(
  agentId: number,
  rows: ReportRow[],
): Promise<void> {
  await getDb()
    .insert(agentReports)
    .values({ agentId, rows })
    .onConflictDoUpdate({
      target: agentReports.agentId,
      set: { rows: sql`excluded."rows"`, reportedAt: sql`now()` },
    });
}

export async function listAgentReports(
  allowed: Set<number>,
): Promise<AgentReportRow[]> {
  if (allowed.size === 0) return [];
  return getDb()
    .select({
      agentId: agentReports.agentId,
      rows: agentReports.rows,
      reportedAt: agentReports.reportedAt,
    })
    .from(agentReports)
    .where(inArray(agentReports.agentId, [...allowed]));
}
