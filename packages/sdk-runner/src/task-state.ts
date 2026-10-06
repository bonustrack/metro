import { randomUUID } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { activityName } from './activity-tasks.js';

export const TASK_LIMIT = 200;
const STATES = ['running', 'completed', 'failed', 'stopped', 'interrupted'] as const;
const REASONS = ['task_error', 'rate_limit', 'worker_restart', 'interrupted', 'provider_error'] as const;
export type TaskReason = (typeof REASONS)[number];

export interface TaskNotice {
  token: string;
  reason: TaskReason;
  attempt: number;
  deliveries: number;
  nextAt: number;
  consumed?: boolean;
}

export interface SavedTask {
  id: string;
  toolUseId: string | null;
  owner: string | null;
  parentToolUseId?: string | null;
  attempt: number;
  state: (typeof STATES)[number];
  events: string[];
  updatedAt: number;
  notice: TaskNotice | null;
}

const integer = (raw: unknown): raw is number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0;
const name = (raw: unknown): raw is string | null => raw === null || activityName(raw) !== null;
const reason = (raw: unknown): raw is TaskReason => REASONS.some((value) => value === raw);

function notice(raw: unknown): raw is TaskNotice | null {
  if (raw === null) return true;
  return isRecord(raw) && activityName(raw.token) !== null && reason(raw.reason) && integer(raw.attempt) && integer(raw.deliveries) && integer(raw.nextAt) && (raw.consumed === undefined || typeof raw.consumed === 'boolean');
}

const events = (raw: unknown): boolean => Array.isArray(raw) && raw.length <= 16 && raw.every((event) => activityName(event) !== null);

function task(raw: unknown): raw is SavedTask {
  if (!isRecord(raw) || activityName(raw.id) === null) return false;
  if (![raw.toolUseId, raw.owner, raw.parentToolUseId ?? null].every(name)) return false;
  if (!events(raw.events)) return false;
  return integer(raw.attempt) && integer(raw.updatedAt) && STATES.some((state) => state === raw.state) && notice(raw.notice);
}

export function savedTasks(raw: unknown): SavedTask[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > TASK_LIMIT || !raw.every(task) || new Set(raw.map((row) => row.id)).size !== raw.length)
    throw new Error('The saved Agent SDK state cannot be read. Restore it before starting.');
  return raw;
}

export function pendingNotice(reason: TaskReason, attempt: number, now: number): TaskNotice {
  return { token: randomUUID(), reason, attempt, deliveries: 0, nextAt: now + (reason === 'rate_limit' ? 30_000 : 0) };
}

export function recoveredTasks(tasks: SavedTask[], now = Date.now()): SavedTask[] {
  return tasks.map((task) => task.state === 'running'
    ? { ...task, state: 'interrupted', updatedAt: now, notice: task.notice?.attempt === task.attempt ? task.notice : pendingNotice('interrupted', task.attempt, now) }
    : task);
}
