import { sameCall, speechTarget, type CallNotice, type CallRoute, type CallSource } from '@metro-labs/core/call';
import { log } from '@metro-labs/core/log';
import type { Activity } from './activity.js';
import type { ApprovalBinding } from './approvals.js';
import type { ChannelEvent } from './channel-text.js';
import type { Inbox } from './inbox.js';
import { callEnded, callStarted, callWords, speechFailed } from './rules.js';

const GENERATIONS_MAX = 512;
const SOURCES_MAX = 2_048;
interface ActiveCall {
  route: CallRoute;
  sources: Set<string>;
  failures: Set<string>;
  inputs: string[];
  controller: AbortController;
}

const routeKey = (route: CallRoute): string => JSON.stringify([route.agentId, route.line, route.from, route.callId, route.generation]);

export class RunnerCalls {
  private active: ActiveCall | null = null;
  private readonly seen = new Set<string>();

  constructor(private readonly inbox: Inbox, private readonly activity?: Activity) {}

  get live(): boolean { return this.active !== null; }

  notice(notice: CallNotice): void {
    if (notice.type === 'started') this.start(notice);
    else if (this.active !== null && sameCall(notice.route, this.active.route)) {
      if (notice.type === 'ended') this.end();
      else if (notice.type === 'heard') this.heard(notice);
      else this.speech(notice);
    }
  }

  reconcile(route: CallRoute | null): void {
    if (route !== null && this.active !== null && sameCall(route, this.active.route)) return;
    this.end();
    if (route !== null) this.activate(route);
  }

  chat(event: ChannelEvent): void {
    const active = this.active;
    if (active === null) return;
    const { meta } = event;
    if (meta.line !== active.route.line || meta.from !== active.route.from || meta.call_id !== active.route.callId || meta.call_generation !== active.route.generation) return;
    if (typeof meta.call_source_id !== 'string' || meta.call_source_id.length === 0 || meta.call_source_id.length > 2048) return;
    if (active.sources.size < SOURCES_MAX) active.sources.add(meta.call_source_id);
  }

  approval(tool: string, input: Record<string, unknown>): ApprovalBinding | null | undefined {
    if (tool !== 'mcp__metro__send' || input.speech === undefined) return undefined;
    const target = speechTarget(input.speech);
    const active = this.active;
    if (active === null || target === null || input.line !== active.route.line || target.callId !== active.route.callId || target.generation !== active.route.generation || !active.sources.has(target.sourceId)) return null;
    return { call: { route: active.route, sourceId: target.sourceId }, signal: active.controller.signal };
  }

  close(): void {
    this.active?.controller.abort();
    this.active = null;
  }

  private activate(route: CallRoute): boolean {
    const key = routeKey(route);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > GENERATIONS_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.end();
    this.active = { route, sources: new Set(), failures: new Set(), inputs: [], controller: new AbortController() };
    this.activity?.call('started');
    return true;
  }

  private start(notice: Extract<CallNotice, { type: 'started' }>): void {
    if (this.activate(notice.route)) this.push(notice, callStarted(notice));
  }

  private heard(notice: Extract<CallNotice, { type: 'heard' }>): void {
    if (notice.text.trim() === '') return;
    this.push(notice, callWords(notice, notice.text));
  }

  private speech(notice: Extract<CallNotice, { type: 'speech' }>): void {
    this.activity?.call(notice.status === 'started' ? 'speaking' : notice.status);
    const active = this.active;
    if (notice.status !== 'failed' || active === null || !active.sources.has(notice.sourceId)) return;
    if (active.failures.has(notice.actionId) || active.failures.size >= SOURCES_MAX) return;
    active.failures.add(notice.actionId);
    try {
      this.inbox.push('note', speechFailed(active.route));
    } catch {
      log.warn('sdk-runner: speech failure context could not be queued');
    }
  }

  private push(source: CallSource, text: string): void {
    const active = this.active;
    if (active === null || active.sources.has(source.sourceId) || active.sources.size >= SOURCES_MAX) return;
    active.sources.add(source.sourceId);
    this.enqueue(text);
  }

  private enqueue(text: string): void {
    const active = this.active;
    if (active === null) return;
    try {
      active.inputs.push(this.inbox.push('call', text));
    } catch {
      this.activity?.call('failed');
      log.warn('sdk-runner: call input queue refused a message');
    }
  }

  private end(): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    active.controller.abort();
    this.inbox.cancel(active.inputs);
    this.activity?.call('ended');
    try {
      this.inbox.push('note', callEnded(active.route));
    } catch {
      log.warn('sdk-runner: call end context could not be queued');
    }
  }
}
