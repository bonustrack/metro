export interface TaskCounts {
  working: number;
  queued: number;
}

const RUNNING = 'run';
const QUEUED = 'queued';

function stateOf(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const state = (row as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
}

function rows(report: Record<string, unknown>, field: string): unknown[] {
  const value = report[field];
  if (!Array.isArray(value))
    throw new Error(`agent-status report has no ${field} array`);
  return value;
}

export function taskCounts(report: unknown): TaskCounts {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('agent-status report is not an object');
  const r = report as Record<string, unknown>;
  const error = r.queue_error;
  if (typeof error === 'string' && error !== '')
    throw new Error(`agent-status could not read the queue: ${error}`);
  return {
    working: rows(r, 'agents').filter((a) => stateOf(a) === RUNNING).length,
    queued: rows(r, 'queue').filter((e) => stateOf(e) === QUEUED).length,
  };
}

export function statusText(counts: TaskCounts): string {
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  return parts.length === 0 ? 'idle' : parts.join(', ');
}

export interface PublishedStatus {
  text: string;
  uptime: number | null;
}

export function shouldPublish(
  prev: PublishedStatus | null,
  next: PublishedStatus,
): boolean {
  if (prev === null) return true;
  if (prev.text !== next.text) return true;
  return (
    prev.uptime !== null && next.uptime !== null && next.uptime < prev.uptime
  );
}
