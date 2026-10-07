import { isRecord } from '@metro-labs/core/is-record';

const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
interface Task { tool: string | null; background: boolean }

export class SkillWork {
  private readonly tasks = new Map<string, Task>();
  private readonly tools = new Map<string, string | null>();
  private overflow = false;
  get safe(): boolean { return !this.overflow && this.tasks.size === 0 && this.tools.size === 0; }

  private blocks(message: Record<string, unknown>): void {
    if (!isRecord(message.message) || !Array.isArray(message.message.content)) return;
    const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : null;
    for (const block of message.message.content.filter(isRecord)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') this.tools.set(block.id, parent);
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') this.tools.delete(block.tool_use_id);
    }
  }

  private retire(id: string, tool = this.tasks.get(id)?.tool): void {
    this.tasks.delete(id);
    if (tool == null) return;
    const retired = new Set([tool]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [child, parent] of this.tools) {
        if (parent === null || !retired.has(parent) || retired.has(child)) continue;
        retired.add(child);
        changed = true;
      }
    }
    for (const child of retired) this.tools.delete(child);
  }

  private background(id: string, value: unknown): boolean {
    return typeof value === 'boolean' ? value : this.tasks.get(id)?.background ?? false;
  }

  private task(message: Record<string, unknown>): void {
    if (typeof message.task_id !== 'string') return;
    const id = message.task_id;
    const tool = typeof message.tool_use_id === 'string' ? message.tool_use_id : this.tasks.get(id)?.tool ?? null;
    if (message.subtype === 'task_started') this.tasks.set(id, { tool, background: this.background(id, message.is_backgrounded) });
    if (message.subtype === 'task_notification') this.retire(id, tool);
    if (message.subtype === 'task_updated' && isRecord(message.patch)) this.patch(id, message.patch);
  }

  private patch(id: string, patch: Record<string, unknown>): void {
    if (TERMINAL.has(String(patch.status))) { this.retire(id); return; }
    if (!this.tasks.has(id) && !['running', 'paused', 'pending'].includes(String(patch.status))) return;
    const task = this.tasks.get(id) ?? { tool: null, background: false };
    if (typeof patch.is_backgrounded === 'boolean') task.background = patch.is_backgrounded;
    this.tasks.set(id, task);
  }

  private snapshot(entries: unknown[]): void {
    const ids = new Set(entries.filter(isRecord).flatMap((task) => typeof task.task_id === 'string' ? [task.task_id] : []));
    for (const [id, task] of this.tasks) if (task.background && !ids.has(id)) this.retire(id);
    for (const id of ids) this.tasks.set(id, { tool: this.tasks.get(id)?.tool ?? null, background: true });
  }

  private frontDone(message: Record<string, unknown>): void {
    if (message.parent_tool_use_id != null) return;
    for (const [id, parent] of this.tools) if (parent === null) this.tools.delete(id);
  }

  observe(message: Record<string, unknown>): void {
    if (this.overflow) return;
    this.blocks(message);
    if (message.type === 'result') this.frontDone(message);
    if (message.type === 'system') this.task(message);
    if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) this.snapshot(message.tasks);
    this.overflow = this.tools.size > 4096 || this.tasks.size > 4096;
  }
}
