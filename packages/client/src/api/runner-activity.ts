import { runnerFailureSummary, type RunnerActivity, type RunnerEventKind, type RunnerFailure, type RunnerInput, type RunnerPhase, type RunnerTask, type RunnerTaskState, type RunnerTool } from '@metro-labs/core/runner-activity';
import type { ClaudeSessionStatus } from './claude-box.js';
import { activityIsStale } from './runner.js';

type Mode = 'live' | 'stale' | 'past';
interface Clock { mode: Mode; at: number; now: number }
interface ActivityRow { id: string; summary: string; details: string; danger: boolean }
interface WorkerRow extends ActivityRow {
  title: string; lastObservedModel: string; status: RunnerTaskState;
  stateLabel: string; tools: string; progress: string;
}

const PHASE: Record<RunnerPhase, string> = {
  starting: 'starting', idle: 'idle', working: 'working', approval: 'waiting for approval',
  compacting: 'compacting the conversation', stopped: 'stopped', error: 'error',
};
const STATE: Record<RunnerTaskState, string> = {
  pending: 'waiting to start', running: 'running', completed: 'completed', failed: 'failed',
  stopped: 'stopped', paused: 'paused', unknown: 'state unknown',
};
const EVENT: Record<RunnerEventKind, string> = {
  turn_started: 'Turn started', turn_finished: 'Turn finished', turn_failed: 'Turn failed',
  tool_started: 'Tool started', tool_finished: 'Tool finished', tool_failed: 'Tool failed',
  task_started: 'Worker started', task_completed: 'Worker completed', task_failed: 'Worker failed',
  task_stopped: 'Worker stopped', task_updated: 'Worker updated', compacting: 'Compacting',
  compacted: 'Compacted', compact_failed: 'Compaction failed', api_retry: 'Model request retried',
  approval_waiting: 'Approval waiting', approval_ended: 'Approval ended',
  permission_denied: 'Permission denied', session_failed: 'Session failed',
};

export { runnerFailureSummary };
export const runnerEventLabel = (kind: RunnerEventKind): string => EVENT[kind];

export const sessionPollMs = (status: ClaudeSessionStatus | undefined, live: boolean): number =>
  live && status?.running === true && status.runner === 'sdk' ? 2_000 : 10_000;

function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 === 0 ? '' : ` ${seconds % 60} s`}`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? '' : ` ${minutes % 60} min`}`;
}

const ago = (at: number, now: number): string => at <= 0 ? 'not reported' : now - at < 1_000 ? 'just now' : `${duration(now - at)} ago`;
const date = (at: number | null): string => at === null || at <= 0 ? 'Not reported' : new Date(at).toLocaleString();
const elapsed = (start: number | null, end: number): string | null => start === null || start <= 0 ? null : duration(end - start);
const terminal = (task: RunnerTask): boolean => ['completed', 'failed', 'stopped'].includes(task.status);

function clockOf(status: ClaudeSessionStatus, activity: RunnerActivity, now: number): Clock {
  const past = !status.running || status.runner === 'cli' || activity.phase === 'stopped';
  const mode = past ? 'past' : activityIsStale(activity.updatedAt, now) ? 'stale' : 'live';
  return { mode, at: mode === 'live' ? Math.max(now, activity.updatedAt) : activity.updatedAt, now };
}

function reportNote(status: ClaudeSessionStatus, activity: RunnerActivity, clock: Clock): string {
  const at = date(activity.updatedAt);
  if (clock.mode === 'past') {
    const reason = !status.running ? 'The session is not running.' : status.runner === 'cli' ? 'Claude Code runs now.' : 'The Agent SDK reported it stopped.';
    return `${reason} Last Agent SDK report: ${at}. History, not live. Times stop at this report.`;
  }
  if (clock.mode === 'stale') {
    const reason = activity.updatedAt > clock.now ? 'The report time is ahead of this device.' : `Last report ${ago(activity.updatedAt, clock.now)}.`;
    return `Stale status. ${reason} Times stop at the last report, ${at}. This may no longer describe the session.`;
  }
  return `Last report ${ago(activity.updatedAt, clock.now)}. Reported state, not a readiness check.`;
}

function mainStatus(activity: RunnerActivity, clock: Clock): string {
  const active = !['idle', 'stopped', 'error'].includes(activity.mainPhase);
  const time = active ? elapsed(activity.mainStartedAt, clock.at) : null;
  const phase = `Main agent: ${PHASE[activity.mainPhase]}${time === null ? '' : ` for ${time}`}`;
  return clock.mode === 'live' ? phase : `${phase} at the last report`;
}

function toolList(tools: RunnerTool[], clock: Clock): string {
  const shown = tools.slice(0, 3).map((tool) => {
    const time = elapsed(tool.startedAt, clock.at);
    return time === null ? tool.name : `${tool.name} (${time})`;
  });
  if (tools.length > 3) shown.push(`+${tools.length - 3} more`);
  return shown.join(', ');
}

function mainTools(activity: RunnerActivity, clock: Clock): string {
  const tools = activity.activeTools.filter((tool) => tool.taskId === null && tool.worker !== true);
  const unassigned = activity.activeTools.filter((tool) => tool.taskId === null && tool.worker === true);
  const suffix = clock.mode === 'live' ? '' : ' at the last report';
  if (activity.activeTools.length === 0 && activity.tools.length > 0) return `Tools in use${suffix}: ${activity.tools.join(', ')}`;
  const main = `Main tools${suffix}: ${tools.length === 0 ? 'None reported' : toolList(tools, clock)}`;
  return unassigned.length === 0 ? main : `${main} · Unassigned worker tools${suffix}: ${toolList(unassigned, clock)}`;
}

function taskDuration(task: RunnerTask, clock: Clock): string | null {
  if (!terminal(task)) return elapsed(task.startedAt, clock.at);
  if (task.durationMs > 0) return duration(task.durationMs);
  return task.endedAt === null ? null : elapsed(task.startedAt, task.endedAt);
}

function taskStatus(task: RunnerTask, clock: Clock, history: 'prefix' | 'suffix' = 'suffix'): string {
  const time = taskDuration(task, clock);
  const label = STATE[task.status];
  if (terminal(task)) return `${label}${time === null ? '' : ` in ${time}`}`;
  const timed = `${label}${time === null || task.status === 'unknown' ? '' : ` (${time})`}`;
  if (clock.mode === 'live') return timed;
  return history === 'prefix' ? `Last report: ${timed}` : `${timed} at the last report`;
}

function taskTools(task: RunnerTask, tools: RunnerTool[], clock: Clock): string {
  if (tools.length > 0 && !terminal(task)) return `${clock.mode === 'live' ? 'using' : 'was using'} ${toolList(tools, clock)}`;
  return task.lastTool === null ? 'no tool reported' : `last tool ${task.lastTool}`;
}

function taskIdentity(task: RunnerTask): string[] {
  return [`Worker ID: ${task.id}`, `Task: ${task.description ?? 'Unknown task'}`, `Last observed model: ${task.lastObservedModel ?? 'Unknown'}`];
}

function taskDetails(task: RunnerTask, tools: RunnerTool[], clock: Clock): string {
  return [
    ...taskIdentity(task),
    `Agent: ${task.agent ?? 'Not reported'}`,
    `Kind: ${task.kind ?? 'Not reported'}`,
    `Status: ${taskStatus(task, clock)}`,
    `Background: ${task.background ? 'Yes' : 'No'}`,
    `Started: ${date(task.startedAt)}`,
    `Last progress: ${date(task.updatedAt)} (${ago(task.updatedAt, clock.now)})`,
    `Ended: ${date(task.endedAt)}`,
    `Elapsed${clock.mode === 'live' || terminal(task) ? '' : ' at the last report'}: ${taskDuration(task, clock) ?? 'Not reported'}`,
    `Runtime reported by SDK: ${duration(task.durationMs)}`,
    `Tool uses: ${task.toolUses}`,
    `Tools${clock.mode === 'live' ? '' : ' at the last report'}: ${tools.length === 0 ? 'None reported' : toolList(tools, clock)}`,
    `Last tool: ${task.lastTool ?? 'Not reported'}`,
  ].join('\n');
}

function workerRows(activity: RunnerActivity, clock: Clock): WorkerRow[] {
  const tasks = [...activity.tasks].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks.map((task) => {
    const tools = activity.activeTools.filter((tool) => tool.taskId === task.id);
    const progress = terminal(task) && task.endedAt !== null ? `ended ${ago(task.endedAt, clock.now)}` : `last progress ${ago(task.updatedAt, clock.now)}`;
    const uses = terminal(task) ? ` · ${task.toolUses} tool uses` : '';
    const stateLabel = taskStatus(task, clock);
    const toolLabel = `${taskTools(task, tools, clock)}${uses}`;
    return {
      id: task.id,
      status: task.status,
      title: task.description ?? 'Unknown task',
      lastObservedModel: task.lastObservedModel ?? 'Unknown',
      stateLabel: taskStatus(task, clock, 'prefix'),
      tools: toolLabel,
      progress,
      summary: `${task.agent ?? task.kind ?? 'Worker'} · ${stateLabel} · ${toolLabel} · ${progress}`,
      details: taskDetails(task, tools, clock),
      danger: task.status === 'failed',
    };
  });
}

function failureRow(failure: RunnerFailure, active: boolean, clock: Clock): { text: string; danger: boolean } {
  const label = !active ? 'Historical failure' : clock.mode === 'live' ? 'Current failure' : 'Failure at last report (not live)';
  const details = [date(failure.at), failure.tool, failure.taskId === null ? null : `worker ${failure.taskId}`, failure.toolUseId === undefined ? null : `tool call ${failure.toolUseId}`].filter((part) => part !== null).join(' · ');
  return { text: `${label}: ${runnerFailureSummary(failure.code, failure.tool)} (${details})`, danger: active && clock.mode === 'live' };
}

function failures(activity: RunnerActivity, clock: Clock): { text: string; danger: boolean }[] {
  const rows = [];
  if (activity.activeFailure) rows.push(failureRow(activity.activeFailure, true, clock));
  if (activity.lastFailure && activity.lastFailure.id !== activity.activeFailure?.id) rows.push(failureRow(activity.lastFailure, false, clock));
  if (activity.activeFailure === undefined && activity.lastError !== null) {
    const active = activity.mainPhase === 'error';
    const label = !active ? 'Historical failure' : clock.mode === 'live' ? 'Current failure' : 'Failure at last report (not live)';
    rows.push({ text: `${label}: ${activity.lastError} (time not reported)`, danger: active && clock.mode === 'live' });
  }
  return rows;
}

function recentEvents(activity: RunnerActivity, clock: Clock): string[] {
  return activity.events.map((event) => [
    ago(event.at, clock.now), EVENT[event.kind], event.tool, event.taskId === null ? null : `worker ${event.taskId}`,
    event.code === undefined ? null : `${event.id === activity.activeFailure?.id && clock.mode === 'live' ? 'Current failure' : 'Historical failure'}: ${runnerFailureSummary(event.code, event.tool)}`,
    event.code === undefined || event.id === undefined ? null : `event ${event.id}`,
    event.toolUseId === undefined ? null : `tool call ${event.toolUseId}`,
  ].filter((part) => part !== null).join(' · '));
}

const INPUT_KIND: Record<RunnerInput['kind'], string> = { chat: 'Chat', call: 'Call', note: 'Status note' };
const INPUT_STATE: Record<RunnerInput['state'], string> = { accepted: 'accepted', consumed: 'consumed by SDK', output: 'first SDK output', completed: 'completed', cancelled: 'cancelled' };
const CALL_STATE: Record<NonNullable<RunnerActivity['callState']>, string> = {
  started: 'started', ended: 'ended', accepted: 'speech accepted', queued: 'speech queued', speaking: 'sending audio',
  completed: 'audio transport completed', interrupted: 'speech interrupted', failed: 'speech failed',
};

function inputDelay(start: number, end: number | null): string {
  if (start <= 0 || end === null) return 'Not reported';
  const ms = Math.max(0, end - start);
  return ms < 1_000 ? `${ms} ms` : duration(ms);
}

function inputRows(activity: RunnerActivity): ActivityRow[] {
  return (activity.inputs ?? []).map((input) => ({
    id: input.id,
    summary: `${INPUT_KIND[input.kind]} · ${INPUT_STATE[input.state]} · accepted ${date(input.acceptedAt)}`,
    details: [
      `Input ID: ${input.id}`, `Accepted: ${date(input.acceptedAt)}`,
      `Dispatched to SDK: ${date(input.dispatchedAt)} (${inputDelay(input.acceptedAt, input.dispatchedAt)} after acceptance)`,
      `Consumed by SDK: ${date(input.consumedAt)} (${inputDelay(input.acceptedAt, input.consumedAt)} after acceptance)`,
      `First SDK output: ${date(input.firstOutputAt)} (${inputDelay(input.acceptedAt, input.firstOutputAt)} after acceptance)`,
      `${input.state === 'cancelled' ? 'Cancelled' : 'Completed'}: ${date(input.completedAt)} (${inputDelay(input.acceptedAt, input.completedAt)} after acceptance)`,
    ].join('\n'),
    danger: false,
  }));
}

function queueStatus(activity: RunnerActivity, clock: Clock): string | null {
  if (activity.queueOldestAt === undefined) return null;
  const age = elapsed(activity.queueOldestAt, clock.at);
  return `Oldest queued input${clock.mode === 'live' ? '' : ' at the last report'}: ${age ?? 'None reported'}`;
}

export function activityView(status: ClaudeSessionStatus, activity: RunnerActivity, now: number): {
  mode: Mode; note: string; main: string; tools: string; workers: WorkerRow[]; events: string[]; failures: { text: string; danger: boolean }[];
  queue: string | null; call: string | null; inputs: ActivityRow[];
} {
  const clock = clockOf(status, activity, now);
  return {
    mode: clock.mode,
    note: reportNote(status, activity, clock),
    main: mainStatus(activity, clock),
    tools: mainTools(activity, clock),
    workers: workerRows(activity, clock),
    events: recentEvents(activity, clock),
    failures: failures(activity, clock),
    queue: queueStatus(activity, clock),
    call: activity.callState === undefined ? null : `Call${clock.mode === 'live' ? '' : ' at the last report'}: ${CALL_STATE[activity.callState]}. Transport status is not proof the caller heard it.`,
    inputs: inputRows(activity),
  };
}
