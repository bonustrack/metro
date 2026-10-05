import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { runnerFailureSummary, type RunnerActivity, type RunnerEvent, type RunnerEventKind, type RunnerFailure, type RunnerFailureCode, type RunnerPhase, type RunnerTool } from '@metro-labs/core/runner-activity';
import { writeAtomic } from '@metro-labs/core/secure-fs';
import { ActivityTasks, activityName } from './activity-tasks.js';
import type { ApprovalAsk } from './approvals.js';

const HEARTBEAT_MS = 5_000;
const MAX_TRACKED = 200;
const MAX_TOOLS = 20;
const MAX_EVENTS = 40;
const STATUS_UNAVAILABLE = 'The SDK status file cannot be written. Check its path and permissions before starting.';
type System = Extract<SDKMessage, { type: 'system' }>;
interface TrackedTool extends RunnerTool { parent: string | null }
interface Approval { tool: string | null; taskId: string | null; worker: boolean }

function sessionFailureCode(err: unknown): RunnerFailureCode {
  const text = err instanceof Error ? err.message : String(err);
  for (const code of ['status_unavailable', 'session_ended', 'interrupted', 'saved_state', 'authentication', 'executable', 'connection'] as const)
    if (text === runnerFailureSummary(code)) return code;
  if (/saved Agent SDK state/i.test(text)) return 'saved_state';
  if (/unauthorized|authentication|invalid.*key|\b40[13]\b/i.test(text)) return 'authentication';
  if (/ENOENT|not found|executable|spawn/i.test(text)) return 'executable';
  if (/ECONN|network|fetch failed|timed? ?out/i.test(text)) return 'connection';
  return 'session_error';
}

export function failureSummary(err: unknown): string { return runnerFailureSummary(sessionFailureCode(err)); }

const PROVIDER_ERRORS: Record<NonNullable<Extract<SDKMessage, { type: 'assistant' }>['error']>, RunnerFailureCode> = {
  authentication_failed: 'authentication', oauth_org_not_allowed: 'authentication', cloud_credential_error: 'authentication', account_on_hold: 'authentication', verification_required: 'authentication',
  billing_error: 'billing', rate_limit: 'rate_limit', overloaded: 'provider_unavailable', server_error: 'provider_unavailable',
  max_output_tokens: 'output_limit', invalid_request: 'invalid_request', model_not_found: 'invalid_request', unknown: 'provider_error',
};

function providerFailure(status: number | null | undefined): RunnerFailureCode {
  const codes: Record<number, RunnerFailureCode | undefined> = { 400: 'invalid_request', 401: 'authentication', 402: 'billing', 403: 'authentication', 404: 'invalid_request', 429: 'rate_limit' };
  if (status === null || status === undefined) return 'provider_error';
  return codes[status] ?? (status >= 500 && status <= 599 ? 'provider_unavailable' : 'provider_error');
}

function readTokenLimit(content: unknown): boolean {
  if (typeof content === 'string') return /File content \([\d,]+ tokens\) exceeds maximum allowed tokens \([\d,]+\)/.test(content.slice(0, 2_048));
  return Array.isArray(content) && content.slice(0, 8).some((block: unknown) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' && readTokenLimit(block.text));
}

function processIdentity(): Pick<RunnerActivity, 'procStart'> {
  if (process.platform !== 'linux') return {};
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return start && /^\d{1,32}$/.test(start) ? { procStart: start } : {};
  } catch {
    log.warn('sdk-runner: process identity is unavailable');
    return {};
  }
}

export class Activity {
  private readonly tools = new Map<string, TrackedTool>();
  private readonly tasks = new ActivityTasks((kind, tool, taskId) => { this.taskEvent(kind, tool ?? null, taskId ?? null); });
  private readonly approvals = new Map<string, Approval>();
  private busy = false;
  private failed = false;
  private providerCode: RunnerFailureCode | null = null;
  private interrupted: RunnerFailure | null = null;
  private compacting = false;
  private ready = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWritten = '';
  private writeFailed = false;
  private readonly state: RunnerActivity = {
    pid: process.pid, ...processIdentity(), runner: 'sdk', phase: 'starting', mainPhase: 'starting', mainStartedAt: null, sessionId: null, updatedAt: Date.now(),
    pending: 0, workers: 0, approvals: 0, tools: [], activeTools: [], tasks: [], events: [], lastError: null, activeFailure: null, lastFailure: null,
  };

  constructor(private readonly path: string) {}

  start(): void {
    this.flush(true);
    if (this.writeFailed) throw new Error(STATUS_UNAVAILABLE);
    this.timer = setInterval(() => { this.flush(true); }, HEARTBEAT_MS);
    this.timer.unref();
  }

  snapshot(): RunnerActivity {
    const s = this.state;
    return {
      ...s, tools: [...s.tools], activeTools: s.activeTools.map((tool) => ({ ...tool })),
      tasks: s.tasks.map((task) => ({ ...task })), events: s.events.map((event) => ({ ...event })),
      activeFailure: s.activeFailure ? { ...s.activeFailure } : null, lastFailure: s.lastFailure ? { ...s.lastFailure } : null,
    };
  }

  pending(count: number): void {
    this.state.pending = count;
    this.update();
  }

  connected(): void {
    this.ready = true;
    this.update();
  }

  approval(id: string, ask: ApprovalAsk | null): void {
    if (ask !== null && this.tasks.isHidden(ask.worker)) return;
    const known = this.approvals.get(id);
    if (ask !== null && known === undefined) {
      const entry: Approval = { tool: activityName(ask.tool), taskId: this.tasks.known(ask.worker), worker: ask.worker !== null };
      this.approvals.set(id, entry);
      this.event('approval_waiting', entry.tool, entry.taskId);
    } else if (ask === null && known !== undefined) {
      this.approvals.delete(id);
      this.event('approval_ended', known.tool, known.taskId);
    }
    this.update();
  }

  fail(message: string): void {
    this.failed = true;
    const failure = this.failure('session_failed', sessionFailureCode(message), true);
    if (failure.code === 'interrupted') this.interrupted = failure;
    this.state.phase = 'error';
    this.state.mainPhase = 'error';
    log.error({ reason: failure.code }, 'sdk-runner: activity error');
    this.flush();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.tasks.stop();
    this.tools.clear();
    this.approvals.clear();
    this.busy = false;
    this.state.mainStartedAt = null;
    this.sync();
    if (this.state.phase !== 'error') this.state.phase = 'stopped';
    if (this.state.mainPhase !== 'error') this.state.mainPhase = 'stopped';
    this.flush(true);
  }

  observe(message: SDKMessage): void {
    if (message.type === 'system') this.system(message);
    else if (message.type === 'result') this.result(message);
    else if (message.type === 'assistant' || message.type === 'user') this.content(message);
    else if (message.type === 'stream_event' && message.parent_tool_use_id === null && !this.turnOpen()) this.turn();
    else return;
    this.update();
  }

  private turnOpen(): boolean {
    return this.busy && this.state.mainStartedAt !== null;
  }

  private system(message: System): void {
    switch (message.subtype) {
      case 'init': this.init(message.session_id); break;
      case 'status': this.status(message); break;
      case 'session_state_changed': this.session(message.state); break;
      case 'api_retry': this.event('api_retry'); break;
      case 'permission_denied': this.event('permission_denied', activityName(message.tool_name), this.tasks.known(message.agent_id)); break;
      default: this.tasks.observe(message); this.settle(message); break;
    }
  }

  private init(sessionId: string): void {
    this.state.sessionId = sessionId;
    this.ready = true;
    this.turn();
  }

  private status(message: Extract<System, { subtype: 'status' }>): void {
    const compacting = message.status === 'compacting';
    if (compacting && !this.compacting) this.event('compacting');
    this.compacting = compacting;
    if (message.compact_result === 'success') this.event('compacted');
    else if (message.compact_result === 'failed') {
      this.failure('compact_failed', 'compact_error', false, null, null, { id: message.uuid });
    }
  }

  private session(state: 'idle' | 'running' | 'requires_action'): void {
    if (state === 'running') this.turn();
    else if (state === 'idle') {
      this.busy = false;
      this.state.mainStartedAt = null;
    }
  }

  private turn(): void {
    this.busy = true;
    if (this.state.mainStartedAt !== null) return;
    this.clearFailure();
    this.providerCode = null;
    this.state.mainStartedAt = Date.now();
    this.event('turn_started');
  }

  private settle(message: System): void {
    if (message.subtype === 'task_notification' && message.tool_use_id !== undefined) this.tools.delete(message.tool_use_id);
    for (const [id, tool] of this.tools) {
      tool.taskId ??= this.tasks.taskFor(tool.parent);
      if (this.tasks.isHidden(tool.parent) || this.taskHiddenOrFinished(tool.taskId)) this.tools.delete(id);
    }
    for (const [id, approval] of this.approvals) if (this.taskHiddenOrFinished(approval.taskId)) this.approvals.delete(id);
  }

  private taskHiddenOrFinished(id: string | null): boolean {
    return id !== null && (this.tasks.isHidden(id) || this.tasks.isFinished(id));
  }

  private taskEvent(kind: RunnerEventKind, tool: string | null, taskId: string | null): void {
    if (kind === 'task_failed') this.failure(kind, 'task_error', false, tool, taskId);
    else this.event(kind, tool, taskId);
  }

  private result(message: Extract<SDKMessage, { type: 'result' }>): void {
    this.busy = (message.queued_turn_count ?? 0) > 0;
    this.compacting = false;
    this.state.mainStartedAt = null;
    for (const [id, tool] of this.tools) if (tool.parent === null) this.tools.delete(id);
    this.failed = message.is_error || message.subtype !== 'success';
    if (!this.failed) {
      this.clearFailure();
      this.providerCode = null;
      this.event('turn_finished');
      return;
    }
    const code = message.subtype === 'success' ? this.providerCode ?? providerFailure(message.api_error_status) : message.subtype;
    this.providerCode = null;
    this.failure('turn_failed', code, true, null, null, { id: message.uuid });
    log.error({ reason: code }, 'sdk-runner: turn failed');
  }

  private content(message: Extract<SDKMessage, { type: 'assistant' | 'user' }>): void {
    const content = message.message.content;
    const parent = message.parent_tool_use_id ?? null;
    if (parent === null && message.type === 'assistant') {
      this.turn();
      if (message.error !== undefined) this.providerCode = message.error === 'unknown' ? null : PROVIDER_ERRORS[message.error];
    }
    if (Array.isArray(content)) for (const block of content) if (isRecord(block)) this.block(block, parent);
  }

  private block(block: Record<string, unknown>, parent: string | null): void {
    if (block.type === 'tool_use' && typeof block.id === 'string') this.tool(block.id, block.name, parent);
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') this.finish(block.tool_use_id, block.is_error === true, parent, block.content);
  }

  private tool(id: string, rawName: unknown, parent: string | null): void {
    if (this.tools.has(id) || this.tools.size >= MAX_TRACKED) return;
    if (this.tasks.isHidden(parent)) return;
    const name = activityName(rawName) ?? 'tool';
    const taskId = this.tasks.taskFor(parent);
    this.tools.set(id, { id, name, taskId, startedAt: Date.now(), parent });
    if (parent === null) this.event('tool_started', name);
    log.info({ tool: name, worker: taskId }, 'sdk-runner: tool started');
  }

  private finish(id: string, failed: boolean, parent: string | null, content: unknown): void {
    const tool = this.tools.get(id);
    if (tool === undefined && this.tasks.isHidden(parent)) return;
    this.tools.delete(id);
    const name = tool?.name ?? 'tool';
    if (failed) {
      this.toolFailure(id, tool, parent, content);
      log.warn({ tool: name }, 'sdk-runner: tool failed');
      return;
    }
    if (tool?.parent === null) this.event('tool_finished', name);
    log.info({ tool: name }, 'sdk-runner: tool finished');
  }

  private toolFailure(id: string, tool: TrackedTool | undefined, parent: string | null, content: unknown): void {
    const name = tool?.name ?? 'tool';
    const code = name === 'Read' && readTokenLimit(content) ? 'read_token_limit' : 'tool_error';
    this.failure('tool_failed', code, false, name, tool?.taskId ?? this.tasks.taskFor(parent), { toolUseId: id });
  }

  private clearFailure(): void {
    this.failed = false;
    this.state.activeFailure = this.interrupted;
    this.state.lastError = this.interrupted === null ? null : runnerFailureSummary(this.interrupted.code);
  }

  private failure(kind: RunnerEventKind, code: RunnerFailureCode, active: boolean, tool: string | null = null, taskId: string | null = null, identity: Pick<RunnerEvent, 'id' | 'toolUseId'> = {}): RunnerFailure {
    const failure: RunnerFailure = { id: activityName(identity.id) ?? randomUUID(), at: Date.now(), kind, code, tool, taskId, ...(activityName(identity.toolUseId) === null ? {} : { toolUseId: identity.toolUseId }) };
    this.state.lastFailure = failure;
    if (active) {
      this.state.activeFailure = failure;
      this.state.lastError = runnerFailureSummary(code, tool);
    }
    this.record(failure);
    return failure;
  }

  private event(kind: RunnerEventKind, tool: string | null = null, taskId: string | null = null): void {
    this.record({ id: randomUUID(), at: Date.now(), kind, tool, taskId });
  }

  private record(event: RunnerEvent): void {
    this.state.events.unshift(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.length = MAX_EVENTS;
  }

  private phaseOf(approval: boolean, working: boolean): RunnerPhase {
    if (!this.ready) return 'starting';
    if (this.compacting) return 'compacting';
    if (approval) return 'approval';
    if (working) return 'working';
    return this.failed ? 'error' : 'idle';
  }

  private sync(): void {
    const tools = [...this.tools.values()];
    this.state.tools = [...new Set(tools.map((tool) => tool.name))].slice(0, MAX_TOOLS);
    this.state.activeTools = tools.slice(0, MAX_TOOLS).map(({ id, name, taskId, startedAt, parent }) => ({ id, name, taskId, startedAt, worker: parent !== null }));
    this.state.tasks = this.tasks.snapshot();
    this.state.workers = this.tasks.running;
    this.state.approvals = this.approvals.size;
  }

  private update(): void {
    this.sync();
    const main = this.busy || this.state.pending > 0;
    const approvals = [...this.approvals.values()];
    this.state.mainPhase = this.phaseOf(approvals.some((approval) => !approval.worker), main || [...this.tools.values()].some((tool) => tool.parent === null));
    this.state.phase = this.phaseOf(approvals.length > 0, main || this.tools.size > 0 || this.state.workers > 0);
    this.flush();
  }

  private flush(force = false): void {
    const next = JSON.stringify({ ...this.state, updatedAt: 0 });
    if (!force && next === this.lastWritten) return;
    this.state.updatedAt = Date.now();
    try {
      writeAtomic(this.path, `${JSON.stringify(this.state)}\n`, 0o600);
      this.lastWritten = next;
      this.writeFailed = false;
    } catch {
      if (!this.writeFailed) log.error('sdk-runner: could not save activity status');
      this.writeFailed = true;
    }
  }
}
