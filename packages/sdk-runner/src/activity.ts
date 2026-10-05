import { readFileSync } from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import type { RunnerActivity, RunnerEventKind, RunnerPhase, RunnerTool } from '@metro-labs/core/runner-activity';
import { writeAtomic } from '@metro-labs/core/secure-fs';
import { ActivityTasks, activityName } from './activity-tasks.js';
import type { ApprovalAsk } from './approvals.js';

const HEARTBEAT_MS = 5_000;
const MAX_TRACKED = 200;
const MAX_TOOLS = 20;
const MAX_EVENTS = 40;
const STATUS_UNAVAILABLE = 'The SDK status file cannot be written. Check its path and permissions before starting.';
type System = Extract<SDKMessage, { type: 'system' }>;
interface TrackedTool extends RunnerTool { main: boolean; parent: string | null }
interface Approval { tool: string | null; taskId: string | null; worker: boolean }

export function failureSummary(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (text === STATUS_UNAVAILABLE) return STATUS_UNAVAILABLE;
  if (/saved Agent SDK state/i.test(text)) return 'The saved Agent SDK state cannot be read. Restore it before starting.';
  if (/unauthorized|authentication|invalid.*key|401|403/i.test(text)) return 'The provider refused authentication. Check the Model page.';
  if (/ENOENT|not found|executable|spawn/i.test(text)) return 'The SDK executable could not start. Prepare the SDK runtime again.';
  if (/ECONN|network|fetch failed|timed? ?out/i.test(text)) return 'The SDK connection failed. Check the server and provider connection.';
  return 'The Agent SDK session failed. Check Terminal and the Model page.';
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
  private compacting = false;
  private ready = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWritten = '';
  private writeFailed = false;
  private readonly state: RunnerActivity = {
    pid: process.pid, ...processIdentity(), runner: 'sdk', phase: 'starting', mainPhase: 'starting', mainStartedAt: null, sessionId: null, updatedAt: Date.now(),
    pending: 0, workers: 0, approvals: 0, tools: [], activeTools: [], tasks: [], events: [], lastError: null,
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
    this.state.lastError = message;
    this.event('session_failed');
    this.state.phase = 'error';
    this.state.mainPhase = 'error';
    log.error({ reason: message }, 'sdk-runner: activity error');
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
      this.state.lastError = 'Conversation compaction failed.';
      this.event('compact_failed');
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
    if (kind === 'task_failed') this.state.lastError = 'A background task failed. See Conversations and Terminal.';
    this.event(kind, tool, taskId);
  }

  private result(message: Extract<SDKMessage, { type: 'result' }>): void {
    this.busy = (message.queued_turn_count ?? 0) > 0;
    this.compacting = false;
    this.state.mainStartedAt = null;
    for (const [id, tool] of this.tools) if (tool.main) this.tools.delete(id);
    this.failed = message.is_error || message.subtype !== 'success';
    if (!this.failed) {
      this.event('turn_finished');
      return;
    }
    const code = message.subtype === 'success' ? 'provider_error' : message.subtype;
    this.state.lastError = `SDK turn failed (${code}). Check Conversations and the Model page.`;
    this.event('turn_failed');
    log.error({ reason: code }, 'sdk-runner: turn failed');
  }

  private content(message: Extract<SDKMessage, { type: 'assistant' | 'user' }>): void {
    const content = message.message.content;
    const parent = message.parent_tool_use_id ?? null;
    if (Array.isArray(content)) for (const block of content) if (isRecord(block)) this.block(block, parent);
    if (parent === null && message.type === 'assistant') this.turn();
  }

  private block(block: Record<string, unknown>, parent: string | null): void {
    if (block.type === 'tool_use' && typeof block.id === 'string') this.tool(block.id, block.name, parent);
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') this.finish(block.tool_use_id, block.is_error === true, parent);
  }

  private tool(id: string, rawName: unknown, parent: string | null): void {
    if (this.tools.has(id) || this.tools.size >= MAX_TRACKED) return;
    if (this.tasks.isHidden(parent)) return;
    const name = activityName(rawName) ?? 'tool';
    const taskId = this.tasks.taskFor(parent);
    this.tools.set(id, { id, name, taskId, startedAt: Date.now(), main: parent === null, parent });
    if (parent === null) this.event('tool_started', name);
    log.info({ tool: name, worker: taskId }, 'sdk-runner: tool started');
  }

  private finish(id: string, failed: boolean, parent: string | null): void {
    const tool = this.tools.get(id);
    if (tool === undefined && this.tasks.isHidden(parent)) return;
    this.tools.delete(id);
    const name = tool?.name ?? 'tool';
    if (failed) {
      this.state.lastError = `${name} failed. See its result in Conversations.`;
      this.event('tool_failed', name, tool?.taskId ?? null);
      log.warn({ tool: name }, 'sdk-runner: tool failed');
      return;
    }
    if (tool?.main === true) this.event('tool_finished', name);
    log.info({ tool: name }, 'sdk-runner: tool finished');
  }

  private event(kind: RunnerEventKind, tool: string | null = null, taskId: string | null = null): void {
    this.state.events.unshift({ at: Date.now(), kind, tool, taskId });
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
    this.state.activeTools = tools.slice(0, MAX_TOOLS).map(({ id, name, taskId, startedAt, main }) => ({ id, name, taskId, startedAt, worker: !main }));
    this.state.tasks = this.tasks.snapshot();
    this.state.workers = this.tasks.running;
    this.state.approvals = this.approvals.size;
  }

  private update(): void {
    this.sync();
    const main = this.busy || this.state.pending > 0;
    const approvals = [...this.approvals.values()];
    this.state.mainPhase = this.phaseOf(approvals.some((approval) => !approval.worker), main || [...this.tools.values()].some((tool) => tool.main));
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
