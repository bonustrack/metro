import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeDir, projectDir, resumeSessionId } from './background.js';
import { scanNative, type NativeEvent } from './native-recovery-scan.js';
import { nativeToken, NATIVE_NOTICE_MAX, NATIVE_TASK_MAX, readNativeState, saveNativeState, withNativeStateLock, type NativeNotice, type NativeRecoveryState, type NativeTask } from './native-recovery-state.js';

const hash = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const taskId = (owner: string, source: string | null, tool: string): string => hash(owner, source ?? '', tool);
const RETRY_MS = [0, 60_000, 10 * 60_000];
const PROMPT_NOTICES = 8;
const taskReason = (task: NativeTask): NativeNotice['reason'] | null => task.state === 'started' ? 'interrupted' : task.state === 'failed' ? 'failed' : task.state === 'restarted' ? 'restarted' : null;

function agentResult(task: NativeTask, outcome: Record<string, unknown>): void {
  if (nativeToken(outcome.agentId)) task.agent = outcome.agentId;
  if (outcome.status === 'completed') task.state = 'completed';
  else if (outcome.status === 'async_launched') task.state = 'started';
}

function messageResult(task: NativeTask, outcome: Record<string, unknown>): void {
  if (outcome.success === true && nativeToken(outcome.resumedAgentId)) { task.agent = outcome.resumedAgentId; task.state = 'started'; }
  else if (outcome.success === true && outcome.resumedAgentId === undefined) task.state = 'completed';
  else if (outcome.success === false) task.state = 'failed';
}

function result(task: NativeTask, event: Extract<NativeEvent, { type: 'result' }>): void {
  if (event.at < task.updatedAt || event.receipt === task.receipt) return;
  if (event.failed) task.state = 'failed';
  else if (event.outcome !== null) {
    if (task.kind === 'Agent') agentResult(task, event.outcome);
    else messageResult(task, event.outcome);
  }
  task.receipt = event.receipt;
  task.updatedAt = event.at;
}

function acknowledge(state: NativeRecoveryState, event: Extract<NativeEvent, { type: 'ack' }>): void {
  const notice = state.notices.find((row) => row.id === event.id);
  if (notice !== undefined && notice.deliveredAt !== null && event.at >= notice.deliveredAt) notice.acknowledgedAt = event.at;
}

function notification(state: NativeRecoveryState, event: Extract<NativeEvent, { type: 'notification' }>): boolean {
  const candidates = state.tasks.filter((row) => row.source === event.source && row.at <= event.at
    && (event.tool === null ? row.agent === event.agent : row.tool === event.tool && (row.agent === null || row.agent === event.agent)));
  if (candidates.length > 1) return false;
  const task = candidates[0];
  if (task !== undefined && event.at >= task.updatedAt) {
    task.agent = event.agent; task.state = event.state; task.receipt = event.receipt; task.updatedAt = event.at;
  }
  return true;
}

function applyEvent(state: NativeRecoveryState, event: NativeEvent): boolean {
  if (event.type === 'ack') { acknowledge(state, event); return true; }
  if (event.type === 'notification') return notification(state, event);
  const id = taskId(state.owner, event.source, event.tool);
  const task = state.tasks.find((row) => row.id === id);
  if (event.type === 'result') { if (task !== undefined) result(task, event); return true; }
  if (task !== undefined) return true;
  if (state.tasks.length >= NATIVE_TASK_MAX) prune(state);
  if (state.tasks.length >= NATIVE_TASK_MAX) return false;
  state.tasks.push({ id, source: event.source, tool: event.tool, kind: event.kind, agent: null, at: event.at, updatedAt: event.at, state: 'started', receipt: event.receipt });
  return true;
}

function addNotice(state: NativeRecoveryState, task: NativeTask | null, reason: NativeNotice['reason'], gap = 'incomplete'): void {
  const id = hash(state.owner, task?.id ?? 'scan', task?.receipt ?? gap, reason);
  if (state.notices.some((row) => row.id === id)) return;
  if (state.notices.length >= NATIVE_NOTICE_MAX) throw new Error('Native recovery has too many retained notices. Saved state has not been overwritten.');
  state.notices.push({ id, task: task?.id ?? null, reason, attempts: 0, deliveredAt: null, acknowledgedAt: null });
}

function prune(state: NativeRecoveryState): void {
  const pending = new Set(state.notices.filter((row) => row.acknowledgedAt === null).map((row) => row.task));
  const acknowledged = new Set(state.notices.filter((row) => row.acknowledgedAt !== null).map((row) => row.id));
  const removable = state.tasks.filter((row) => !pending.has(row.id) && (taskReason(row) === null || acknowledged.has(hash(state.owner, row.id, row.receipt, taskReason(row) ?? ''))))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const removed = new Set(removable.slice(0, Math.max(0, state.tasks.length - NATIVE_TASK_MAX / 2)).map((row) => row.id));
  state.tasks = state.tasks.filter((row) => !removed.has(row.id));
  state.notices = state.notices.filter((row) => row.task === null || !removed.has(row.task));
}

function noticeLine(state: NativeRecoveryState, notice: NativeNotice): string {
  const task = state.tasks.find((row) => row.id === notice.task);
  const subject = task === undefined ? 'Native task history' : `${task.kind} receipt ${task.tool}${task.agent === null ? '' : `, worker ${task.agent}`}`;
  const facts = {
    interrupted: 'has no terminal receipt. Work may have run before interruption; its outcome is unknown.',
    failed: 'reported failure. Earlier side effects may already have happened.',
    restarted: 'was stopped by worker restart, not explicit user cancellation.',
    incomplete: 'could not be fully checked within the bounded local scan. Other unfinished work may exist.',
  };
  return `${subject} ${facts[notice.reason]}\nAfter taking responsibility for this notice, emit a standalone assistant text block exactly: METRO_RECOVERY_ACK ${notice.id}`;
}

function promptFor(state: NativeRecoveryState, notices: NativeNotice[]): string {
  return [
    'Metro native recovery notice. This is recovery bookkeeping, not a new user task or permission to repeat actions.',
    `Owner conversation: ${state.owner}. Native worker routing may have lost ownership metadata; this notice does not repair it.`,
    'Review the affected work and current evidence, using a read-only worker if needed. Do not blindly rerun a task, resend a message, or repeat another side effect. Acknowledge awareness only; acknowledgment is not proof of successful completion. Do not post these bookkeeping markers to chat.',
    ...notices.map((notice) => noticeLine(state, notice)),
  ].join('\n\n');
}

function prepare(state: NativeRecoveryState, root: string): void {
  const scan = scanNative(root, state.owner, state.files, state.tasks);
  prune(state);
  for (const event of scan.events) if (!applyEvent(state, event)) scan.gaps.push('unresolved-receipts');
  state.files = scan.files;
  for (const task of state.tasks) {
    const reason = taskReason(task);
    if (reason !== null) addNotice(state, task, reason);
  }
  for (const gap of scan.gaps) addNotice(state, null, 'incomplete', gap);
}

function isDue(notice: NativeNotice, now: number): boolean {
  return notice.acknowledgedAt === null && notice.attempts < RETRY_MS.length
    && (notice.deliveredAt === null || now - notice.deliveredAt >= (RETRY_MS[notice.attempts] ?? Infinity));
}

export interface NativeRecoveryDeps { env?: NodeJS.ProcessEnv; cwd?: string; now?: number }

function locations(owner: string, deps: NativeRecoveryDeps): { path: string; root: string } {
  const env = deps.env ?? process.env;
  const given = env.HOME?.trim();
  const home = resolve(given === '' ? homedir() : given ?? homedir());
  return { path: join(home, '.metro', 'native-recovery', `${owner}.json`), root: projectDir(claudeDir(env), deps.cwd ?? process.cwd()) };
}

export function nativeRecoveryArgs(extra: string[], deps: NativeRecoveryDeps = {}): string[] {
  const owner = resumeSessionId(extra);
  if (extra.length !== 2 || owner === undefined || (extra[0] !== '--resume' && extra[0] !== '-r')) return extra;
  const { path, root } = locations(owner, deps);
  return withNativeStateLock(path, () => {
    const state = readNativeState(path, owner);
    prepare(state, root);
    const now = deps.now ?? Date.now();
    const due = state.notices.filter((row) => isDue(row, now)).slice(0, PROMPT_NOTICES);
    for (const notice of due) { notice.attempts += 1; notice.deliveredAt = now; }
    saveNativeState(path, state);
    return due.length === 0 ? extra : [...extra, promptFor(state, due)];
  });
}
