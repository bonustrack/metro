import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerEventKind, RunnerTask, RunnerTaskState } from '@metro-labs/core/runner-activity';

export const activityName = (name: unknown): string | null => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(name) ? name : null;
const live = (task: RunnerTask): boolean => ['running', 'pending', 'paused'].includes(task.status);
const terminal = (status: RunnerTaskState): boolean => ['completed', 'failed', 'stopped'].includes(status);
type System = Extract<SDKMessage, { type: 'system' }>;
type Emit = (kind: RunnerEventKind, tool?: string | null, taskId?: string | null) => void;

export class ActivityTasks {
  private readonly tasks = new Map<string, RunnerTask>();
  private readonly parents = new Map<string, string>();
  private readonly hidden = new Map<string, string>();
  constructor(private readonly emit: Emit) {}

  snapshot(): RunnerTask[] {
    return [...this.tasks.values()].sort((a, b) => Number(live(b)) - Number(live(a)) || b.updatedAt - a.updatedAt).slice(0, 30).map((task) => ({ ...task }));
  }

  get running(): number { return [...this.tasks.values()].filter(live).length; }
  taskFor(parent: string | null | undefined): string | null { return parent ? this.parents.get(parent) ?? null : null; }
  known(id: string | null | undefined): string | null { return id && this.tasks.has(id) ? id : null; }
  isHidden(id: string | null): boolean { return id !== null && this.hidden.has(id); }
  isFinished(id: string): boolean { const task = this.tasks.get(id); return task !== undefined && !live(task); }

  observe(message: System): void {
    switch (message.subtype) {
      case 'task_started': this.start(message); break;
      case 'task_progress': this.progress(message); break;
      case 'task_updated': this.patch(message); break;
      case 'task_notification': this.end(message); break;
      case 'background_tasks_changed': this.replace(message); break;
      default: break;
    }
  }

  stop(): void {
    for (const task of this.tasks.values()) if (live(task)) this.status(task, 'stopped');
  }

  private get(id: string): RunnerTask | null {
    if (!activityName(id) || this.hidden.has(id)) return null;
    const known = this.tasks.get(id);
    if (known) return known;
    if (this.tasks.size >= 200) {
      const old = [...this.tasks.values()].find((task) => !live(task));
      if (!old) return null;
      this.tasks.delete(old.id);
      for (const [parent, taskId] of this.parents) if (taskId === old.id) this.parents.delete(parent);
    }
    const task: RunnerTask = { id, kind: null, agent: null, status: 'unknown', background: false, startedAt: 0, updatedAt: Date.now(), endedAt: null, lastTool: null, toolUses: 0, durationMs: 0 };
    this.tasks.set(id, task);
    return task;
  }

  private hide(id: string, toolUseId?: string): void {
    this.tasks.delete(id);
    const parents = [...this.parents].filter(([, task]) => task === id).map(([parent]) => parent);
    for (const key of [id, toolUseId, ...parents]) {
      if (key === undefined) continue;
      const oldest = this.hidden.keys().next();
      if (this.hidden.size >= 400 && !oldest.done) this.hidden.delete(oldest.value);
      this.hidden.set(key, id);
    }
  }

  private show(id: string): RunnerTask | null {
    this.hidden.delete(id);
    const task = this.get(id);
    if (!task) return null;
    for (const [key, taskId] of this.hidden) {
      if (taskId !== id) continue;
      this.hidden.delete(key);
      this.parents.set(key, id);
    }
    return task;
  }

  private start(message: Extract<System, { subtype: 'task_started' }>): void {
    if (message.ambient || message.skip_transcript) { this.hide(message.task_id, message.tool_use_id); return; }
    const task = this.get(message.task_id);
    if (!task) return;
    task.kind = activityName(message.task_type);
    task.agent = activityName(message.subagent_type);
    task.background = message.is_backgrounded === true;
    task.startedAt = Date.now();
    task.endedAt = null;
    if (message.tool_use_id) this.parents.set(message.tool_use_id, task.id);
    this.status(task, 'running');
  }

  private progress(message: Extract<System, { subtype: 'task_progress' }>): void {
    const task = this.tasks.get(message.task_id);
    if (!task || terminal(task.status)) return;
    task.lastTool = activityName(message.last_tool_name);
    task.toolUses = message.usage.tool_uses;
    task.durationMs = message.usage.duration_ms;
    task.updatedAt = Date.now();
  }

  private patch(message: Extract<System, { subtype: 'task_updated' }>): void {
    const task = this.tasks.get(message.task_id);
    if (!task) return;
    if (message.patch.is_backgrounded !== undefined) task.background = message.patch.is_backgrounded;
    if (message.patch.status) this.status(task, message.patch.status === 'killed' ? 'stopped' : message.patch.status);
    task.updatedAt = Date.now();
  }

  private end(message: Extract<System, { subtype: 'task_notification' }>): void {
    if (message.ambient || message.skip_transcript) { this.hide(message.task_id); return; }
    const task = this.get(message.task_id);
    if (!task) return;
    if (message.usage) {
      task.durationMs = message.usage.duration_ms;
      task.toolUses = message.usage.tool_uses;
    }
    this.status(task, message.status);
  }

  private replace(message: Extract<System, { subtype: 'background_tasks_changed' }>): void {
    const ids = new Set(message.tasks.map((task) => task.task_id));
    for (const task of this.tasks.values()) if (task.background && live(task) && !ids.has(task.id)) this.status(task, 'unknown');
    for (const row of message.tasks) {
      if (row.ambient) { this.hide(row.task_id); continue; }
      const task = this.show(row.task_id);
      if (!task || terminal(task.status)) continue;
      task.kind = activityName(row.task_type);
      task.background = true;
      this.status(task, 'running');
    }
  }

  private status(task: RunnerTask, status: RunnerTaskState): void {
    const changed = task.status !== status;
    task.status = status;
    task.updatedAt = Date.now();
    task.endedAt = terminal(status) ? task.updatedAt : null;
    if (!changed) return;
    const event: Partial<Record<RunnerTaskState, RunnerEventKind>> = { running: 'task_started', completed: 'task_completed', failed: 'task_failed', stopped: 'task_stopped' };
    this.emit(event[status] ?? 'task_updated', null, task.id);
  }
}
