import { isRecord } from './is-record.js';

const PHASES = ['starting', 'idle', 'working', 'approval', 'compacting', 'stopped', 'error'] as const;
const TASK_STATES = ['pending', 'running', 'completed', 'failed', 'stopped', 'paused', 'unknown'] as const;
const EVENTS = ['turn_started', 'turn_finished', 'turn_failed', 'tool_started', 'tool_finished', 'tool_failed', 'task_started', 'task_completed', 'task_failed', 'task_stopped', 'task_updated', 'compacting', 'compacted', 'compact_failed', 'api_retry', 'approval_waiting', 'approval_ended', 'permission_denied', 'session_failed'] as const;
export type RunnerPhase = (typeof PHASES)[number];
export type RunnerTaskState = (typeof TASK_STATES)[number];
export type RunnerEventKind = (typeof EVENTS)[number];

const FAILURE = {
  authentication: 'The provider refused authentication. Check the Model page.',
  billing: 'The provider refused billing. Check the Model page.',
  rate_limit: 'The provider rate limit was reached. Retry later or check the Model page.',
  provider_unavailable: 'The provider is unavailable. Retry later or check the Model page.',
  invalid_request: 'The provider rejected the request. Check Conversations and the Model page.',
  output_limit: 'The model reached its output token limit. Check Conversations.',
  provider_error: 'SDK turn failed (provider_error). Check Conversations and the Model page.',
  error_during_execution: 'SDK turn failed (error_during_execution). Check Conversations and the Model page.',
  error_max_turns: 'SDK turn failed (error_max_turns). Check Conversations and the Model page.',
  error_max_budget_usd: 'SDK turn failed (error_max_budget_usd). Check Conversations and the Model page.',
  error_max_structured_output_retries: 'SDK turn failed (error_max_structured_output_retries). Check Conversations and the Model page.',
  read_token_limit: 'Read exceeded its token limit. Read a smaller range with offset and limit, or search the file.',
  tool_error: 'A tool failed. See its result in Conversations.',
  task_error: 'A background task failed. See Conversations and Terminal.',
  compact_error: 'Conversation compaction failed.',
  status_unavailable: 'The SDK status file cannot be written. Check its path and permissions before starting.',
  saved_state: 'The saved Agent SDK state cannot be read. Restore it before starting.',
  executable: 'The SDK executable could not start. Prepare the SDK runtime again.',
  connection: 'The SDK connection failed. Check the server and provider connection.',
  session_ended: 'The Agent SDK session ended unexpectedly.',
  interrupted: 'The SDK stopped before finishing a chat request. Check Conversations before retrying; actions may already have run.',
  session_error: 'The Agent SDK session failed. Check Terminal and the Model page.',
} as const;
export type RunnerFailureCode = keyof typeof FAILURE;

export function runnerFailureSummary(code: RunnerFailureCode, tool: string | null = null): string {
  return code === 'tool_error' && name(tool) !== null ? `${tool} failed. See its result in Conversations.` : FAILURE[code];
}

export interface RunnerTask {
  id: string;
  kind: string | null;
  agent: string | null;
  description?: string | null;
  lastObservedModel?: string | null;
  status: RunnerTaskState;
  background: boolean;
  startedAt: number;
  firstStartedAt?: number;
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
  id?: string;
  at: number;
  kind: RunnerEventKind;
  tool: string | null;
  toolUseId?: string;
  taskId: string | null;
  code?: RunnerFailureCode;
}

export interface RunnerFailure extends RunnerEvent {
  id: string;
  code: RunnerFailureCode;
}

export interface RunnerInput {
  id: string;
  kind: 'chat' | 'call' | 'note';
  state: 'accepted' | 'consumed' | 'output' | 'completed' | 'cancelled';
  acceptedAt: number;
  dispatchedAt: number | null;
  consumedAt: number | null;
  firstOutputAt: number | null;
  completedAt: number | null;
}

export interface RunnerActivity {
  pid: number;
  procStart?: string;
  cancelSignal?: 'SIGUSR2';
  runner: 'sdk';
  phase: RunnerPhase;
  mainPhase: RunnerPhase;
  mainStartedAt: number | null;
  sessionId: string | null;
  updatedAt: number;
  pending: number;
  queueOldestAt?: number | null;
  inputs?: RunnerInput[];
  callState?: 'started' | 'ended' | 'accepted' | 'queued' | 'speaking' | 'completed' | 'interrupted' | 'failed';
  workers: number;
  approvals: number;
  tools: string[];
  activeTools: RunnerTool[];
  tasks: RunnerTask[];
  events: RunnerEvent[];
  lastError: string | null;
  activeFailure?: RunnerFailure | null;
  lastFailure?: RunnerFailure | null;
}

const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const phase = (value: unknown): value is RunnerPhase => PHASES.some((p) => p === value);
const taskState = (value: unknown): value is RunnerTaskState => TASK_STATES.some((s) => s === value);
const eventKind = (value: unknown): value is RunnerEventKind => EVENTS.some((e) => e === value);
const name = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
const sessionId = (value: unknown): string | null => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : null;

export function runnerTaskDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = value.split(/\r|\n|\p{Zl}|\p{Zp}/u, 1)[0] ?? '';
  const description = line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160).trim();
  return description.length > 0 ? description : null;
}

export const runnerTaskModel = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+[\]-]{0,127}$/.test(value) ? value : null;

function task(raw: unknown): RunnerTask | null {
  if (!isRecord(raw) || !name(raw.id) || !taskState(raw.status)) return null;
  return {
    id: String(raw.id), kind: name(raw.kind), agent: name(raw.agent), status: raw.status, background: raw.background === true,
    startedAt: count(raw.startedAt), updatedAt: count(raw.updatedAt), endedAt: count(raw.endedAt) || null,
    lastTool: name(raw.lastTool), toolUses: count(raw.toolUses), durationMs: count(raw.durationMs),
    ...(count(raw.firstStartedAt) > 0 ? { firstStartedAt: count(raw.firstStartedAt) } : {}),
    ...(raw.description === undefined ? {} : { description: runnerTaskDescription(raw.description) }),
    ...(raw.lastObservedModel === undefined ? {} : { lastObservedModel: runnerTaskModel(raw.lastObservedModel) }),
  };
}

function tool(raw: unknown): RunnerTool | null {
  if (!isRecord(raw) || !name(raw.id) || !name(raw.name)) return null;
  return { id: String(raw.id), name: String(raw.name), taskId: name(raw.taskId), startedAt: count(raw.startedAt), ...(typeof raw.worker === 'boolean' ? { worker: raw.worker } : {}) };
}

const failureCode = (value: unknown): value is RunnerFailureCode => typeof value === 'string' && Object.hasOwn(FAILURE, value);
const failureKind = (value: RunnerEventKind): boolean => ['turn_failed', 'tool_failed', 'task_failed', 'compact_failed', 'session_failed'].includes(value);

function event(raw: unknown): RunnerEvent | null {
  if (!isRecord(raw) || !eventKind(raw.kind) || count(raw.at) === 0) return null;
  return {
    at: count(raw.at), kind: raw.kind, tool: name(raw.tool), taskId: name(raw.taskId),
    ...(name(raw.id) === null ? {} : { id: String(raw.id) }),
    ...(name(raw.toolUseId) === null ? {} : { toolUseId: String(raw.toolUseId) }),
    ...(failureKind(raw.kind) && failureCode(raw.code) ? { code: raw.code } : {}),
  };
}

function failure(raw: unknown): RunnerFailure | null {
  const parsed = event(raw);
  return parsed?.id !== undefined && parsed.code !== undefined ? { ...parsed, id: parsed.id, code: parsed.code } : null;
}

function safeError(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const known = Object.values(FAILURE).find((text) => text === raw);
  if (known !== undefined) return known;
  const tool = /^([A-Za-z0-9_.:-]{1,128}) failed\. See its result in Conversations\.$/.exec(raw)?.[1];
  return tool === undefined ? FAILURE.session_error : runnerFailureSummary('tool_error', tool);
}

function list<T>(raw: unknown, parse: (item: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parse).filter((item): item is T => item !== null).slice(0, max);
}

function processIdentity(value: unknown): Pick<RunnerActivity, 'procStart'> {
  return typeof value === 'string' && /^\d{1,32}$/.test(value) ? { procStart: value } : {};
}

function failureFields(raw: Record<string, unknown>): Pick<RunnerActivity, 'lastError' | 'activeFailure' | 'lastFailure'> {
  const activeFailure = failure(raw.activeFailure);
  return {
    lastError: Object.hasOwn(raw, 'activeFailure') ? activeFailure === null ? null : runnerFailureSummary(activeFailure.code, activeFailure.tool) : safeError(raw.lastError),
    ...(Object.hasOwn(raw, 'activeFailure') ? { activeFailure } : {}),
    ...(Object.hasOwn(raw, 'lastFailure') ? { lastFailure: failure(raw.lastFailure) } : {}),
  };
}

function input(raw: unknown): RunnerInput | null {
  if (!isRecord(raw) || sessionId(raw.id) === null) return null;
  const kind = (['chat', 'call', 'note'] as const).find((value) => value === raw.kind);
  const state = (['accepted', 'consumed', 'output', 'completed', 'cancelled'] as const).find((value) => value === raw.state);
  if (kind === undefined || state === undefined) return null;
  return {
    id: String(raw.id), kind, state, acceptedAt: count(raw.acceptedAt),
    dispatchedAt: count(raw.dispatchedAt) || null, consumedAt: count(raw.consumedAt) || null,
    firstOutputAt: count(raw.firstOutputAt) || null, completedAt: count(raw.completedAt) || null,
  };
}

function inputFields(raw: Record<string, unknown>): Pick<RunnerActivity, 'inputs' | 'queueOldestAt' | 'callState'> {
  const states = ['started', 'ended', 'accepted', 'queued', 'speaking', 'completed', 'interrupted', 'failed'] as const;
  const callState = states.find((state) => state === raw.callState);
  return {
    ...(raw.inputs === undefined ? {} : { inputs: list(raw.inputs, input, 40) }),
    ...(raw.queueOldestAt === undefined ? {} : { queueOldestAt: count(raw.queueOldestAt) || null }),
    ...(callState === undefined ? {} : { callState }),
  };
}

export function parseRunnerActivity(raw: unknown): RunnerActivity | null {
  if (!isRecord(raw) || raw.runner !== 'sdk' || !phase(raw.phase) || count(raw.pid) === 0 || count(raw.updatedAt) === 0) return null;
  return {
    runner: 'sdk', pid: count(raw.pid), ...processIdentity(raw.procStart), phase: raw.phase, mainPhase: phase(raw.mainPhase) ? raw.mainPhase : raw.phase,
    ...(raw.cancelSignal === 'SIGUSR2' ? { cancelSignal: raw.cancelSignal } : {}),
    mainStartedAt: count(raw.mainStartedAt) || null, sessionId: sessionId(raw.sessionId), updatedAt: count(raw.updatedAt),
    pending: count(raw.pending), workers: count(raw.workers), approvals: count(raw.approvals),
    tools: list(raw.tools, name, 20), activeTools: list(raw.activeTools, tool, 20),
    tasks: list(raw.tasks, task, 30), events: list(raw.events, event, 40),
    ...failureFields(raw), ...inputFields(raw),
  };
}
