import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { activityIsStale } from '@metro-labs/client/api/runner';

type Activity = NonNullable<ClaudeSessionStatus['activity']>;
type Task = Activity['tasks'][number];

export type NowDot = 'success' | 'white' | 'quiet' | 'danger';

export interface NowRow {
  id: string;
  title: string;
  subtitle: string;
  dot: NowDot;
  since: number | null;
}

export interface RightNow {
  live: boolean;
  main: NowRow;
  helpers: NowRow[];
  active: number;
}

const ACTIVE = new Set<Task['status']>(['pending', 'running', 'paused']);
const HELPERS_MAX = 3;

const MAIN: Record<Activity['mainPhase'], { title: string; dot: NowDot }> = {
  starting: { title: 'Starting', dot: 'quiet' },
  idle: { title: 'Waiting for messages', dot: 'quiet' },
  working: { title: 'Working', dot: 'success' },
  approval: { title: 'Waiting for your approval', dot: 'white' },
  compacting: { title: 'Making room in its memory', dot: 'success' },
  stopped: { title: 'Stopped', dot: 'quiet' },
  error: { title: 'Ran into a problem', dot: 'danger' },
};

function waitingTasks(activity: Activity): Set<string> {
  const waiting = new Set<string>();
  for (const event of [...activity.events].sort((a, b) => a.at - b.at)) {
    if (event.taskId === null) continue;
    if (event.kind === 'approval_waiting') waiting.add(event.taskId);
    else if (event.kind === 'approval_ended' || event.kind === 'permission_denied') waiting.delete(event.taskId);
  }
  return waiting;
}

function helperRow(task: Task, waiting: boolean): NowRow {
  const base = { id: task.id, title: task.description ?? 'A helper task', since: task.startedAt > 0 ? task.startedAt : null };
  if (waiting) return { ...base, subtitle: 'Helper, waiting for you', dot: 'white' };
  if (task.status === 'pending') return { ...base, subtitle: 'Helper, about to start', dot: 'quiet' };
  if (task.status === 'paused') return { ...base, subtitle: 'Helper, paused', dot: 'quiet' };
  return { ...base, subtitle: 'Helper', dot: 'success' };
}

function stoppedRow(status: ClaudeSessionStatus): NowRow {
  return { id: 'main', title: 'Not running', subtitle: status.blocked ?? 'The agent is stopped', dot: 'danger', since: null };
}

export function rightNow(status: ClaudeSessionStatus, now: number): RightNow {
  if (!status.running) return { live: false, main: stoppedRow(status), helpers: [], active: 0 };
  const activity = status.activity;
  if (activity === null || status.legacyRunner || activityIsStale(activity.updatedAt, now))
    return { live: false, main: { id: 'main', title: 'Running', subtitle: 'Main thread', dot: 'success', since: null }, helpers: [], active: 0 };
  const phase = MAIN[activity.mainPhase];
  const main = { id: 'main', title: phase.title, subtitle: 'Main thread', dot: phase.dot, since: activity.mainStartedAt };
  const waiting = waitingTasks(activity);
  const active = activity.tasks.filter((task) => ACTIVE.has(task.status)).sort((a, b) => b.startedAt - a.startedAt);
  const helpers = active.slice(0, HELPERS_MAX).map((task) => helperRow(task, waiting.has(task.id)));
  return { live: true, main, helpers, active: active.length };
}

export function workingLine(now: RightNow): string | null {
  if (!now.live) return null;
  const helpers = now.active;
  if (now.main.dot === 'success') return helpers === 0 ? now.main.title : `${now.main.title} with ${String(helpers)} ${helpers === 1 ? 'helper' : 'helpers'}`;
  return helpers === 0 ? null : `${String(helpers)} ${helpers === 1 ? 'helper is' : 'helpers are'} working`;
}

export function sinceLabel(since: number | null, now: number): string | null {
  if (since === null) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} d`;
}
