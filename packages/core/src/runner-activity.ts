import { isRecord } from './is-record.js';

const PHASES = ['starting', 'idle', 'working', 'approval', 'compacting', 'stopped', 'error'] as const;
const TASK_STATES = ['pending', 'running', 'completed', 'failed', 'stopped', 'paused', 'unknown'] as const;
const EVENTS = ['turn_started', 'turn_finished', 'turn_failed', 'tool_started', 'tool_finished', 'tool_failed', 'task_started', 'task_completed', 'task_failed', 'task_stopped', 'task_updated', 'compacting', 'compacted', 'compact_failed', 'api_retry', 'approval_waiting', 'approval_ended', 'permission_denied', 'session_failed'] as const;
export type RunnerPhase = (typeof PHASES)[number];
export type RunnerTaskState = (typeof TASK_STATES)[number];
export type RunnerEventKind = (typeof EVENTS)[number];

export interface RunnerTask {
  id: string;
  kind: string | null;
  agent: string | null;
  status: RunnerTaskState;
  background: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastTool: string | null;
  toolUses: number;
  durationMs: number;
}

export interface RunnerTool {
  id: string;
  name: string;
  taskId: string | null;
  worker?: boolean;
  startedAt: number;
}

export interface RunnerEvent {
  at: number;
  kind: RunnerEventKind;
  tool: string | null;
  taskId: string | null;
}

export interface RunnerActivity {
  pid: number;
  procStart?: string;
  runner: 'sdk';
  phase: RunnerPhase;
  mainPhase: RunnerPhase;
  mainStartedAt: number | null;
  sessionId: string | null;
  updatedAt: number;
  pending: number;
  workers: number;
  approvals: number;
  tools: string[];
  activeTools: RunnerTool[];
  tasks: RunnerTask[];
  events: RunnerEvent[];
  lastError: string | null;
}

const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const phase = (value: unknown): value is RunnerPhase => PHASES.some((p) => p === value);
const taskState = (value: unknown): value is RunnerTaskState => TASK_STATES.some((s) => s === value);
const eventKind = (value: unknown): value is RunnerEventKind => EVENTS.some((e) => e === value);
const name = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
const sessionId = (value: unknown): string | null => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : null;

function task(raw: unknown): RunnerTask | null {
  if (!isRecord(raw) || !name(raw.id) || !taskState(raw.status)) return null;
  return {
    id: String(raw.id), kind: name(raw.kind), agent: name(raw.agent), status: raw.status, background: raw.background === true,
    startedAt: count(raw.startedAt), updatedAt: count(raw.updatedAt), endedAt: count(raw.endedAt) || null,
    lastTool: name(raw.lastTool), toolUses: count(raw.toolUses), durationMs: count(raw.durationMs),
  };
}

function tool(raw: unknown): RunnerTool | null {
  if (!isRecord(raw) || !name(raw.id) || !name(raw.name)) return null;
  return { id: String(raw.id), name: String(raw.name), taskId: name(raw.taskId), startedAt: count(raw.startedAt), ...(typeof raw.worker === 'boolean' ? { worker: raw.worker } : {}) };
}

function event(raw: unknown): RunnerEvent | null {
  if (!isRecord(raw) || !eventKind(raw.kind) || count(raw.at) === 0) return null;
  return { at: count(raw.at), kind: raw.kind, tool: name(raw.tool), taskId: name(raw.taskId) };
}

function list<T>(raw: unknown, parse: (item: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parse).filter((item): item is T => item !== null).slice(0, max);
}

function processIdentity(value: unknown): Pick<RunnerActivity, 'procStart'> {
  return typeof value === 'string' && /^\d{1,32}$/.test(value) ? { procStart: value } : {};
}

export function parseRunnerActivity(raw: unknown): RunnerActivity | null {
  if (!isRecord(raw) || raw.runner !== 'sdk' || !phase(raw.phase) || count(raw.pid) === 0 || count(raw.updatedAt) === 0) return null;
  return {
    runner: 'sdk', pid: count(raw.pid), ...processIdentity(raw.procStart), phase: raw.phase, mainPhase: phase(raw.mainPhase) ? raw.mainPhase : raw.phase,
    mainStartedAt: count(raw.mainStartedAt) || null, sessionId: sessionId(raw.sessionId), updatedAt: count(raw.updatedAt),
    pending: count(raw.pending), workers: count(raw.workers), approvals: count(raw.approvals),
    tools: list(raw.tools, name, 20), activeTools: list(raw.activeTools, tool, 20),
    tasks: list(raw.tasks, task, 30), events: list(raw.events, event, 40),
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 300) : null,
  };
}
