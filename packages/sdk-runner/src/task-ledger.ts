import { isRecord } from '@metro-labs/core/is-record';
import { activityName } from './activity-tasks.js';
import type { Unanswered } from './inbox.js';
import { pendingNotice, TASK_LIMIT, type SavedTask, type TaskReason } from './task-state.js';

interface Tool { name: string; parent: string | null }
const failed = (text: unknown): TaskReason => typeof text === 'string' && /\b429\b|rate.?limit/i.test(text.slice(0, 4_096)) ? 'rate_limit' : 'task_error';

export class TaskLedger {
  private readonly rows = new Map<string, SavedTask>();
  private readonly tools = new Map<string, Tool>();
  private readonly errors = new Map<string, TaskReason>();

  constructor(tasks: SavedTask[], private readonly save: (tasks: SavedTask[], handled?: ReadonlySet<string>) => void) {
    for (const task of tasks) this.rows.set(task.id, task);
  }

  snapshot(): SavedTask[] { return [...this.rows.values()]; }

  interrupted(inputs: Unanswered[], now: number): void {
    let changed = false;
    for (const input of inputs) {
      const id = `input:${input.uuid ?? input.at}`;
      if (!this.rows.has(id) && !this.room()) break;
      const task = this.get(id, now);
      if (task.notice !== null) continue;
      task.state = 'interrupted';
      task.owner = 'main';
      task.notice = pendingNotice('interrupted', task.attempt, now);
      changed = true;
    }
    if (changed) this.save(this.snapshot());
  }

  observe(m: Record<string, unknown>, now: number): void {
    if (m.type === 'assistant' || m.type === 'user') this.content(m, now);
    else if (m.type === 'result') this.result(m, now);
    else if (m.type === 'system') this.system(m, now);
  }

  private result(m: Record<string, unknown>, now: number): void {
    if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return;
    if (m.is_error === true) this.turnFailed(m, now);
    this.errors.delete('main');
  }

  private system(m: Record<string, unknown>, now: number): void {
    if (m.subtype === 'background_tasks_changed') { this.background(m, now); return; }
    const id = activityName(m.task_id);
    if (id === null) return;
    if (m.ambient === true || m.skip_transcript === true) { this.hide(id); return; }
    const event = activityName(m.uuid);
    const known = this.rows.get(id);
    if (event !== null && known?.events.includes(event)) return;
    this.taskEvent(id, m, event, now);
  }

  cancel(handled: ReadonlySet<string> = new Set()): void {
    for (const task of this.rows.values()) {
      if (task.state === 'running') task.state = 'stopped';
      task.notice = null;
    }
    this.save(this.snapshot(), new Set([...this.rows.keys(), ...handled]));
  }

  changed(handled?: ReadonlySet<string>): void { this.save(this.snapshot(), handled); }

  private taskEvent(id: string, m: Record<string, unknown>, event: string | null, now: number): void {
    if (m.subtype === 'task_started') this.start(id, m.tool_use_id, event, now);
    else if (m.subtype === 'task_notification') this.end(id, m, event, now);
    else if (m.subtype === 'task_updated' && isRecord(m.patch) && this.rows.has(id)) {
      this.end(id, { status: m.patch.status === 'killed' ? 'stopped' : m.patch.status, summary: m.patch.error }, event, now);
    } else if (m.subtype === 'task_progress') this.progress(id, now);
  }

  private progress(id: string, now: number): void {
    const task = this.rows.get(id);
    if (task?.state !== 'running' || now - task.updatedAt < 10_000) return;
    task.updatedAt = now;
    this.save(this.snapshot());
  }

  private turnFailed(m: Record<string, unknown>, now: number): void {
    if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return;
    const id = activityName(m.uuid);
    if (id === null) return;
    const task = this.get(`turn:${id}`, now);
    task.owner = 'main';
    task.state = 'failed';
    const reason = m.api_error_status === 429 ? 'rate_limit' : this.errors.get('main') ?? 'provider_error';
    task.notice ??= pendingNotice(reason, task.attempt, now);
    this.save(this.snapshot());
  }

  private room(): boolean {
    if (this.rows.size < TASK_LIMIT) return true;
    const old = this.snapshot().find((task) => task.notice === null && task.state !== 'running');
    if (old === undefined) return false;
    this.rows.delete(old.id);
    return true;
  }

  private get(id: string, now: number): SavedTask {
    const known = this.rows.get(id);
    if (known !== undefined) return known;
    if (!this.room()) throw new Error('The saved Agent SDK task ledger is full. Handle pending recovery notices before starting more work.');
    const task: SavedTask = { id, toolUseId: null, owner: null, attempt: 0, state: 'interrupted', events: [], updatedAt: now, notice: null };
    this.rows.set(id, task);
    return task;
  }

  private start(id: string, rawTool: unknown, event: string | null, now: number): void {
    const task = this.get(id, now);
    if (task.state !== 'running') task.attempt += 1;
    task.state = 'running';
    if (event !== null) task.events = [...task.events, event].slice(-16);
    task.updatedAt = now;
    task.toolUseId = activityName(rawTool) ?? task.toolUseId;
    this.resolveOwners();
    this.save(this.snapshot());
  }

  private resolveOwners(): void {
    for (const task of this.rows.values()) {
      if (task.owner !== null) continue;
      const tool = task.toolUseId === null ? undefined : this.tools.get(task.toolUseId);
      if (tool !== undefined) task.parentToolUseId = tool.parent;
      const parent = task.parentToolUseId;
      if (parent === null) task.owner = 'main';
      else if (parent !== undefined) task.owner = this.snapshot().find((owner) => owner.toolUseId === parent)?.id ?? null;
    }
  }

  private end(id: string, m: Record<string, unknown>, event: string | null, now: number): void {
    if (m.status !== 'completed' && m.status !== 'failed' && m.status !== 'stopped') return;
    const task = this.get(id, now);
    task.toolUseId = activityName(m.tool_use_id) ?? task.toolUseId;
    task.state = m.reason === 'worker_restart' ? 'interrupted' : m.status;
    if (event !== null) task.events = [...task.events, event].slice(-16);
    task.updatedAt = now;
    this.failedTask(task, m, now);
    this.errors.delete(task.toolUseId ?? '');
    this.resolveOwners();
    this.save(this.snapshot());
  }

  private failedTask(task: SavedTask, m: Record<string, unknown>, now: number): void {
    if (m.status !== 'failed' && m.reason !== 'worker_restart') return;
    const reason = m.reason === 'worker_restart' ? 'worker_restart' : this.errors.get(task.toolUseId ?? '') ?? failed(m.summary);
    if (task.notice?.attempt !== task.attempt) task.notice = pendingNotice(reason, task.attempt, now);
    else if (reason === 'rate_limit' && task.notice.reason !== reason) {
      task.notice.reason = reason;
      task.notice.nextAt = Math.max(task.notice.nextAt, now + 30_000);
    }
  }

  private hide(id: string): void {
    if (this.rows.delete(id)) this.save(this.snapshot());
  }

  private background(m: Record<string, unknown>, now: number): void {
    if (!Array.isArray(m.tasks)) return;
    for (const row of m.tasks) {
      if (!isRecord(row)) continue;
      const id = activityName(row.task_id);
      if (id === null) continue;
      if (row.ambient === true) this.hide(id);
      else if (!this.rows.has(id)) this.start(id, undefined, activityName(m.uuid), now);
    }
  }

  private content(m: Record<string, unknown>, now: number): void {
    const parent = activityName(m.parent_tool_use_id);
    this.rememberError(m, parent);
    if (!isRecord(m.message) || !Array.isArray(m.message.content)) return;
    for (const block of m.message.content.filter(isRecord)) {
      if (block.type === 'tool_use' && m.type === 'assistant') this.tool(block, parent);
      else if (block.type === 'tool_result' && m.type === 'user') this.receipt(block, m.tool_use_result, now);
    }
  }

  private rememberError(m: Record<string, unknown>, parent: string | null): void {
    if (m.type === 'assistant' && typeof m.error === 'string') this.errors.set(parent ?? 'main', m.error === 'rate_limit' ? 'rate_limit' : 'provider_error');
  }

  private tool(block: Record<string, unknown>, parent: string | null): void {
    const id = activityName(block.id);
    const name = activityName(block.name);
    if (id === null || name === null) return;
    this.tools.set(id, { name, parent });
    if (this.snapshot().some((task) => task.owner === null)) {
      this.resolveOwners();
      this.save(this.snapshot());
    }
    if (this.tools.size <= 400) return;
    const oldest = this.tools.keys().next().value;
    if (oldest !== undefined) this.tools.delete(oldest);
  }

  private receipt(block: Record<string, unknown>, structured: unknown, now: number): void {
    const tool = typeof block.tool_use_id === 'string' ? this.tools.get(block.tool_use_id) : undefined;
    if (tool?.name !== 'SendMessage' || block.is_error === true) return;
    const raw = isRecord(structured) ? structured : this.renderedReceipt(block.content);
    if (!isRecord(raw) || raw.success !== true) return;
    const id = activityName(raw.resumedAgentId);
    if (id !== null) this.resumed(id, activityName(block.tool_use_id), now);
  }

  private resumed(id: string, event: string | null, now: number): void {
    const task = this.rows.get(id);
    if (task?.state === 'running' || (event !== null && task?.events.includes(event))) return;
    this.start(id, undefined, event, now);
  }

  private renderedReceipt(content: unknown): unknown {
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(isRecord).filter((block) => block.type === 'text').map((block) => block.text).join('') : '';
    if (text.length > 4_096) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
}
