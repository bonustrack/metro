import { categorise } from './task-redact.js';

export interface WireRow {
  kind: 'agent' | 'queue';
  id: string;
  state: string;
  label: string | null;
  who: string | null;
  needs: string[];
  blocked_on: string | null;
  started_at: string | null;
  ended_at: string | null;
}

const AGENT_ID = /^[0-9a-f]{7}$/;
const QUEUE_ID = /^q[0-9]{1,6}$/;

const iso = (seconds: unknown): string | null =>
  typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;

const text = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;

function safeId(raw: unknown, kind: 'agent' | 'queue'): string {
  if (typeof raw !== 'string') return '?';
  const value = kind === 'agent' ? raw.slice(0, 7).toLowerCase() : raw.toLowerCase();
  return (kind === 'agent' ? AGENT_ID : QUEUE_ID).test(value) ? value : '?';
}

const LIVE_AGENT = new Set(['run']);
const OPEN_QUEUE = new Set(['queued', 'blocked', 'doing']);

function agentRow(a: Record<string, unknown>, redact: boolean): WireRow {
  return {
    kind: 'agent',
    id: safeId(a.id, 'agent'),
    state: typeof a.state === 'string' ? a.state : 'unknown',
    label: redact ? categorise(a.desc) : text(a.desc),
    who: null,
    needs: [],
    blocked_on: redact ? null : text(a.why),
    started_at: iso(a.start),
    ended_at: iso(a.end),
  };
}

function queueRow(e: Record<string, unknown>, redact: boolean): WireRow {
  const resource = Array.isArray(e.resource) ? e.resource : [];
  return {
    kind: 'queue',
    id: safeId(e.id, 'queue'),
    state: typeof e.state === 'string' ? e.state : 'unknown',
    label: redact ? categorise(e.task) : text(e.task),
    who: redact ? null : text(e.who),
    needs: redact
      ? []
      : resource.flatMap((r) => {
          const one = text(r);
          return one === null ? [] : [one];
        }),
    blocked_on: redact ? null : text(e.blocked_on),
    started_at: typeof e.added === 'string' ? e.added : null,
    ended_at: typeof e.done_at === 'string' ? e.done_at : null,
  };
}

export function wireRows(
  report: unknown,
  redact: boolean,
  limit = 40,
): WireRow[] {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('agent-status report is not an object');
  const r = report as Record<string, unknown>;
  const agents = Array.isArray(r.agents) ? r.agents : [];
  const queue = Array.isArray(r.queue) ? r.queue : [];
  const isRec = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;
  const live = agents
    .filter(isRec)
    .filter((a) => LIVE_AGENT.has(String(a.state)))
    .map((a) => agentRow(a, redact));
  const owed = queue
    .filter(isRec)
    .filter((e) => OPEN_QUEUE.has(String(e.state)))
    .map((e) => queueRow(e, redact));
  return [...live, ...owed].slice(0, limit);
}
