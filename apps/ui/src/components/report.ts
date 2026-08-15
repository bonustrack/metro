export interface ReportRow {
  kind: 'agent' | 'queue';
  id: string;
  state: string;
  label: string | null;
  who: string | null;
  needs: string[];
  blockedOn: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface AgentReport {
  agentId: number;
  rows: ReportRow[];
  reportedAt: number;
}

export interface ReportPanel {
  agentId: number;
  name: string;
  report: AgentReport | null;
  stale: boolean;
}

export const STALE_MS = 5 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const RUNNING = new Set(['run', 'doing']);
const OPEN = new Set(['queued', 'blocked']);
const DEAD = new Set(['DIED', 'died?', 'FAILED', 'KILLED', 'STOPPD']);

export function ageLabel(ms: number): string {
  if (ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

export function spanLabel(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 24) return `${hours}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
  return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
}

export function rowTiming(row: ReportRow, now: number): string {
  if (row.startedAt === null) return '';
  const end = row.endedAt ?? now;
  const span = spanLabel(Math.max(0, end - row.startedAt));
  if (row.kind === 'queue') return `owed ${span}`;
  return row.endedAt === null ? span : `ran ${span}`;
}

export function tone(row: ReportRow): 'live' | 'dead' | 'open' | 'settled' {
  if (DEAD.has(row.state)) return 'dead';
  if (RUNNING.has(row.state)) return 'live';
  return OPEN.has(row.state) ? 'open' : 'settled';
}

export function isStale(report: AgentReport, now: number): boolean {
  return now - report.reportedAt >= STALE_MS;
}

export function summarise(rows: ReportRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([state, n]) => `${n} ${state}`);
  return parts.length === 0 ? 'nothing reported' : parts.join(' · ');
}

export function visibleRows(rows: ReportRow[]): ReportRow[] {
  const rank = (r: ReportRow): number => {
    const t = tone(r);
    return t === 'dead' ? 0 : t === 'live' ? 1 : t === 'open' ? 2 : 3;
  };
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
}

export function reportPanels(
  agents: { id: number; name: string }[],
  reports: AgentReport[],
  now: number,
): ReportPanel[] {
  const byAgent = new Map(reports.map((r) => [r.agentId, r]));
  return agents.map((agent) => {
    const found = byAgent.get(agent.id) ?? null;
    return {
      agentId: agent.id,
      name: agent.name,
      report: found,
      stale: found === null || isStale(found, now),
    };
  });
}
