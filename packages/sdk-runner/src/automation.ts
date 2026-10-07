import { randomUUID } from 'node:crypto';
import type { AutomationStore } from '@metro-labs/core/automation-store';
import type { AutomationRequest, AutomationStatus } from '@metro-labs/core/automation-types';
import type { Inbox, Uuid } from './inbox.js';
import { startedCommand, uuidsOf } from './session-watch.js';
import { automationShellCommand } from './automation-command.js';

const SETTLED = new Set<AutomationStatus['state']>(['completed', 'coalesced', 'cancelled']);
const LIVE = new Set<AutomationStatus['state']>(['dispatched', 'consumed', 'awaiting-completion']);

function prompt(request: AutomationRequest, token: string): string {
  return `[Metro local automation. This is a stored scheduled task, not a new message from a person or fresh approval. The local agent account submitted it. Verify its existing authorization and later pauses before acting. All normal delegation, tool, permission and model rules still apply.\nRoutine: ${request.routine}\nScheduled slot: ${new Date(request.slot).toISOString()}\nDelivery: ${request.uuid}\nCompletion token: ${token}\nDelegate the sweep to one background worker. Reuse its existing owner if active. A parent response or worker launch does not complete this routine. When the sweep itself has finished checking and recording its decisions, its worker must run this exact command:\n${automationShellCommand(['finish', request.uuid, token, 'completed'])}\nIf this sweep itself cannot safely proceed, use blocked instead of completed and report the actual blocker once. This is only a completion receipt, never permission to repeat a side effect. Recovered issue workers may continue after the sweep, but record their claims before finishing. On interruption run this exact status command:\n${automationShellCommand(['status', request.routine])}\nVerify the original worker and effects before resolving this receipt; never blindly replay the stored prompt. No automatic chat post is required.\nStored prompt, JSON encoded:\n${JSON.stringify(request.prompt)}\n]`;
}

export class Automation {
  private readonly staged = new Map<string, { request: AutomationRequest; token: Uuid }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly inbox: Inbox,
    private readonly interrupted: (uuid: Uuid, at: number) => void,
    private readonly fail: (err: unknown) => void,
    private readonly now = Date.now,
  ) {}

  start(): void {
    this.store.recover();
    for (const request of this.store.requests()) {
      const status = this.store.status(request.uuid);
      if (status !== null && LIVE.has(status.state)) this.save(status, 'interrupted');
    }
    this.poll();
    this.timer = setInterval(() => {
      try { this.poll(); } catch (err) { this.fail(err); }
    }, 5_000);
    this.timer.unref();
  }

  poll(): void {
    if (this.closed) return;
    this.resolve();
    const requests = this.store.requests();
    const statuses = new Map(this.store.statuses().map((status) => [status.uuid, status]));
    for (const request of requests) {
      const status = statuses.get(request.uuid);
      if (status !== undefined && (status.state === 'interrupted' || status.state === 'failed')) this.interrupted(request.uuid, request.createdAt);
    }
    this.admit(requests, statuses);
    this.store.prune();
  }

  dispatched(uuid: string | undefined): void {
    if (uuid === undefined) return;
    const item = this.staged.get(uuid);
    if (item === undefined) return;
    try {
      this.store.saveStatus({ uuid: item.request.uuid, token: item.token, state: 'dispatched', updatedAt: this.now() });
      this.staged.delete(uuid);
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  observe(m: Record<string, unknown>): void {
    if (this.closed || (m.parent_tool_use_id !== undefined && m.parent_tool_use_id !== null)) return;
    const started = startedCommand(m);
    const ids = new Set([...(uuidsOf(m) ?? []), ...(started === null ? [] : [started])]);
    if (ids.size === 0) return;
    for (const request of this.store.requests()) {
      if (!ids.has(request.uuid)) continue;
      const status = this.store.status(request.uuid);
      if (status !== null) this.observeStatus(status, m);
    }
  }

  private observeStatus(status: AutomationStatus, m: Record<string, unknown>): void {
    if (!LIVE.has(status.state)) return;
    if (m.type === 'result') this.save(status, m.is_error !== true && m.subtype === 'success' ? 'awaiting-completion' : 'failed');
    else if (status.state === 'dispatched') this.save(status, 'consumed');
  }

  close(cancel = false): void {
    if (this.closed && !cancel) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (!cancel) return;
    this.resolve();
    for (const request of this.store.requests()) {
      const status = this.store.status(request.uuid);
      if (status !== null && LIVE.has(status.state)) this.save(status, 'cancelled');
    }
  }

  private save(status: AutomationStatus, state: AutomationStatus['state']): void {
    this.store.saveStatus({ ...status, state, updatedAt: this.now() });
  }

  private resolve(): void {
    const statuses = new Map(this.store.statuses().map((status) => [status.uuid, status]));
    for (const receipt of this.store.resolutions()) {
      const status = statuses.get(receipt.uuid);
      if (status === undefined || status.token !== receipt.token) throw new Error('A local automation completion receipt does not match its dispatched task.');
      if (SETTLED.has(status.state)) continue;
      const state = receipt.outcome === 'completed' ? 'completed' : 'failed';
      if (status.state === state) continue;
      this.save(status, state);
      statuses.set(receipt.uuid, { ...status, state });
    }
  }

  private admit(requests: AutomationRequest[], statuses: ReadonlyMap<string, AutomationStatus>): void {
    const routines = new Map<string, AutomationRequest[]>();
    for (const request of requests) {
      const list = routines.get(request.routine) ?? [];
      list.push(request);
      routines.set(request.routine, list);
    }
    for (const list of routines.values()) {
      if (list.some((request) => this.staged.has(request.uuid))) continue;
      if (list.some((request) => {
        const status = statuses.get(request.uuid);
        return status !== undefined && !SETTLED.has(status.state);
      })) continue;
      const latest = this.coalesce(list, statuses);
      if (latest === null || this.inbox.pending > 0) continue;
      const token = randomUUID();
      this.staged.set(latest.uuid, { request: latest, token });
      this.inbox.automation(prompt(latest, token), latest.uuid, latest.createdAt);
    }
  }

  private coalesce(list: AutomationRequest[], statuses: ReadonlyMap<string, AutomationStatus>): AutomationRequest | null {
    const pending = list.filter((request) => !statuses.has(request.uuid) && request.slot <= this.now()).sort((a, b) => b.slot - a.slot);
    const latest = pending.shift();
    if (latest === undefined) return null;
    const watermark = Math.max(...list.filter((request) => statuses.has(request.uuid)).map((request) => request.slot));
    if (latest.slot <= watermark) pending.push(latest);
    for (const request of pending) this.store.saveStatus({ uuid: request.uuid, token: randomUUID(), state: 'coalesced', updatedAt: this.now() });
    return latest.slot <= watermark ? null : latest;
  }
}
