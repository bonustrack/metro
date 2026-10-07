import { randomUUID } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import type { Inbox, Unanswered, Uuid } from './inbox.js';
import type { SessionStore } from './session-store.js';
import { completedCommand, startedCommand, uuidsOf } from './session-watch.js';
import { TaskLedger } from './task-ledger.js';
import { TASK_LIMIT, type SavedTask } from './task-state.js';

const DELAYS = [30_000, 120_000, 300_000];
const marker = (token: string): string => `[metro-task-handled:${token}]`;
interface Delivery { uuid: Uuid; tokens: string[]; consumed: boolean; completed?: boolean }

function noticeText(tasks: SavedTask[]): string {
  const rows = tasks.flatMap((task) => task.notice === null ? [] : [
    `Task ${task.id}, owner ${task.owner ?? 'unknown'}, attempt ${task.attempt}, state ${task.state}, reason ${task.notice.reason}. Acknowledge with ${marker(task.notice.token)}`,
  ]);
  return `[Metro task recovery. These are pending obligations, not new user requests.\n${rows.join('\n')}\nCheck the existing worker and its transcript before deciding whether to continue it or report a blocker. Reuse its owner; do not create a duplicate worker or blindly repeat edits, sends or commands. Respect the existing tool and approval policy. After handling each obligation, put its exact acknowledgment marker on its own line in your assistant response, not in a chat send. Merely receiving this notice is not acknowledgment. Rate-limit reminders use bounded backoff; do not start a retry loop.]`;
}

function mainLines(m: Record<string, unknown>): string[] {
  if (m.type !== 'assistant' || m.aborted === true || !isRecord(m.message) || !Array.isArray(m.message.content)) return [];
  return m.message.content.filter(isRecord).filter((block) => block.type === 'text' && typeof block.text === 'string').flatMap((block) => String(block.text).split('\n').map((line) => line.trim()));
}

const turnBoundary = (m: Record<string, unknown>): boolean => m.type === 'system'
  && (m.subtype === 'init' || (m.subtype === 'session_state_changed' && m.state === 'idle'));

export class TaskRecovery {
  readonly ledger: TaskLedger;
  private readonly deliveries = new Map<string, Delivery>();
  private readonly currentInputs = new Set<string>();
  private readonly acknowledged = new Map<string, string[]>();
  private replyInputs: string[] | null = null;
  private turnBoundaries = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deferredUntil = 0;
  private closed = false;

  constructor(private readonly store: SessionStore, private readonly inbox: Inbox, tasks: SavedTask[], interrupted: Unanswered[], private readonly fail: (err: unknown) => void, private readonly now = Date.now, private readonly handled = (): void => undefined) {
    this.ledger = new TaskLedger(tasks, (rows, handled) => { store.saveTasks(rows, handled); });
    this.ledger.interrupted(interrupted, now());
  }

  observe(m: Record<string, unknown>): void {
    if (this.closed) return;
    if (!this.recoveryOnly(m)) this.ledger.observe(m, this.now());
    if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return;
    this.replyTurn(m);
    this.consume(m);
    if (m.type === 'result') this.settle(m);
    this.retireDeliveries(m);
    this.schedule();
  }

  start(): void { this.schedule(); }

  close(cancel: boolean): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (cancel) this.store.cancelTasks(this.ledger.cancel(), this.inbox.activeUuids());
  }

  private retireDeliveries(m: Record<string, unknown>): void {
    const completed = completedCommand(m);
    if (completed !== null) {
      const delivery = this.deliveries.get(completed);
      if (delivery !== undefined) delivery.completed = true;
      this.currentInputs.delete(completed);
    }
    if (m.type !== 'system' || m.subtype !== 'session_state_changed' || m.state !== 'idle') return;
    for (const [id, delivery] of this.deliveries) if (delivery.completed === true) this.deliveries.delete(id);
  }

  private recoveryOnly(m: Record<string, unknown>): boolean {
    if (m.type !== 'result') return false;
    const ids = uuidsOf(m) ?? [];
    const offered = new Set<string | undefined>(this.ledger.snapshot().map((task) => task.notice?.offered));
    if (ids.length > 0) return ids.every((id) => this.deliveries.has(id) || offered.has(id));
    return this.inbox.startedUuids().length === 0 && [...this.deliveries.values()].some((delivery) => delivery.consumed);
  }

  private replyTurn(m: Record<string, unknown>): void {
    if (turnBoundary(m)) {
      this.turnBoundaries = true;
      this.replyInputs = null;
    }
    if (m.type === 'assistant' || m.type === 'stream_event') this.replyInputs = uuidsOf(m) ?? this.replyInputs;
    const ended = m.type === 'result' ? uuidsOf(m) ?? [] : [completedCommand(m)];
    if (this.replyInputs?.some((id) => ended.includes(id))) this.replyInputs = null;
  }

  private replyIds(m: Record<string, unknown>): string[] {
    const stamped = uuidsOf(m) ?? this.replyInputs;
    if (stamped !== null) return stamped;
    return !this.turnBoundaries && this.currentInputs.size === 1 ? [...this.currentInputs] : [];
  }

  private consume(m: Record<string, unknown>): void {
    const command = startedCommand(m) ?? completedCommand(m);
    const ids = [...(uuidsOf(m) ?? []), ...(command === null ? [] : [command])];
    for (const id of ids) this.currentInputs.add(id);
    for (const delivery of this.deliveries.values()) {
      if (ids.includes(delivery.uuid)) delivery.consumed = true;
    }
    this.consumed(ids);
    this.acknowledge(m);
  }

  private consumed(ids: string[]): void {
    let changed = false;
    for (const task of this.ledger.snapshot()) {
      const notice = task.notice;
      if (notice?.offered === undefined || !ids.includes(notice.offered)) continue;
      notice.nextAt = this.now() + (DELAYS[notice.deliveries] ?? 300_000);
      notice.deliveries += 1;
      notice.consumed = true;
      delete notice.offered;
      changed = true;
    }
    if (changed) this.ledger.changed();
  }

  private acknowledge(m: Record<string, unknown>): void {
    const lines = mainLines(m);
    if (lines.length === 0) return;
    const ids = this.replyIds(m);
    for (const task of this.ledger.snapshot()) {
      if (task.notice?.consumed !== true || !lines.includes(marker(task.notice.token))) continue;
      this.acknowledged.set(task.notice.token, [...new Set([...(this.acknowledged.get(task.notice.token) ?? []), ...ids])]);
    }
  }

  private settle(m: Record<string, unknown>): void {
    const ids = uuidsOf(m) ?? [];
    for (const id of ids) { this.deliveries.delete(id); this.currentInputs.delete(id); }
    const handled = m.subtype === 'success' && m.is_error !== true ? this.handledTasks(ids) : new Set<string>();
    for (const [token, inputs] of this.acknowledged) {
      const pending = inputs.filter((id) => !ids.includes(id));
      if (pending.length === 0) this.acknowledged.delete(token);
      else this.acknowledged.set(token, pending);
    }
    if (handled.size === 0) return;
    this.ledger.changed(handled);
    this.ledger.interrupted(this.store.interrupted(), this.now());
    if (this.ledger.snapshot().every((task) => task.notice === null)) this.handled();
  }

  private handledTasks(ids: string[]): Set<string> {
    const handled = new Set<string>();
    for (const task of this.ledger.snapshot()) {
      if (task.notice === null || !this.acknowledged.get(task.notice.token)?.some((id) => ids.includes(id))) continue;
      task.handledAttempt = task.notice.attempt;
      task.notice = null;
      handled.add(task.id);
    }
    return handled;
  }

  private eligible(task: SavedTask): boolean {
    const notice = task.notice;
    if (notice === null || notice.deliveries >= DELAYS.length) return false;
    return ![...this.deliveries.values()].some((delivery) => delivery.completed !== true && delivery.tokens.includes(notice.token));
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    const pending = this.ledger.snapshot().filter((task) => this.eligible(task));
    if (pending.length === 0) return;
    const at = Math.max(this.deferredUntil, Math.min(...pending.map((task) => task.notice?.nextAt ?? Infinity)));
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.deliver(); } catch (err) { this.fail(err); }
    }, Math.min(300_000, Math.max(0, at - this.now())));
    this.timer.unref();
  }

  private deliver(): void {
    const due = this.ledger.snapshot().filter((task) => this.eligible(task) && (task.notice?.nextAt ?? Infinity) <= this.now());
    const offered = due[0]?.notice?.offered;
    const tasks = due.filter((task) => task.notice?.offered === offered).slice(0, 20);
    if (tasks.length === 0) { this.schedule(); return; }
    const text = noticeText(tasks);
    if (this.deliveries.size >= TASK_LIMIT * DELAYS.length || !this.inbox.accepts('note', text)) {
      this.deferredUntil = this.now() + 30_000;
      this.schedule();
      return;
    }
    const uuid = offered ?? randomUUID();
    const tokens: string[] = [];
    for (const task of tasks) {
      if (task.notice === null) continue;
      task.notice.offered = uuid;
      tokens.push(task.notice.token);
    }
    this.ledger.changed();
    this.deliveries.set(uuid, { uuid, tokens, consumed: false });
    this.inbox.push('note', text, undefined, uuid);
    this.schedule();
  }
}
