import { randomUUID } from 'node:crypto';
import { sameCall, type CallNotice, type CallRoute, type CallSource, type SpeechStatus, type SpeechTarget } from '@metro-labs/core/call';
import { str } from '@metro-labs/core/str';
import { log } from '@metro-labs/core/log';
import { agentIdForLine, allowlistForLine, lineReceives, mayApprove, senderPermitted, accountFromLine } from '../agents/map.js';
import { eventInScope } from '../agents/scope.js';
import { harnessRunner } from '../claude/runner.js';
import { policyFor, type Access } from '../policy/policy.js';

export interface SharedSpeechAction {
  actionId: string;
  text: string;
  isValid(): boolean;
  status(status: SpeechStatus): void;
}

export interface SharedCallTransport {
  enqueue(action: SharedSpeechAction): boolean;
  terminate(): void;
}

export interface SpeechReceipt {
  actionId: string;
  sourceId: string;
  status: SpeechStatus;
  duplicate: boolean;
}

interface Action extends SpeechReceipt {
  text: string;
}

interface Active {
  route: CallRoute;
  at: number;
  transport: SharedCallTransport;
  sources: Set<string>;
  actions: Map<string, Action>;
}

export interface SharedCallBridge {
  available(route: CallRoute): boolean;
  notify(notice: CallNotice): boolean;
  revoked(route: CallRoute): void;
}

const SOURCES_MAX = 1024;
const TEXT_MAX = 32_000;
const sourceValid = (sourceId: string): boolean => sourceId.length > 0 && sourceId.length <= 2048;

const authorized = (route: CallRoute): boolean =>
  agentIdForLine(route.line) === route.agentId && eventInScope(new Set([route.agentId]), route.line) && lineReceives(route.line) &&
  mayApprove(route.line, route.from) && senderPermitted(allowlistForLine(route.line), route.from);

function access(route: CallRoute): Access {
  const account = accountFromLine(route.line);
  return account === undefined ? 'deny' : policyFor({ kind: 'channel', station: account.station, account: account.accountId }, { name: 'send', group: 'write' });
}

export class SharedCalls {
  private active: Active | null = null;
  private bridge: SharedCallBridge | null = null;

  constructor(private readonly permitted = authorized, private readonly policy = access) {}

  connect(bridge: SharedCallBridge): void {
    this.disconnect();
    this.bridge = bridge;
  }

  disconnect(): void {
    this.revoke();
    this.bridge = null;
  }

  revoke(): void {
    const active = this.active;
    if (active !== null) this.end(active.route);
  }

  open(route: CallRoute, sourceId: string, transport: SharedCallTransport): boolean {
    if (!this.permitted(route) || this.bridge?.available(route) !== true || !sourceValid(sourceId)) return false;
    if (this.active !== null && sameCall(this.active.route, route)) return this.active.transport === transport && this.active.sources.has(sourceId);
    if (this.active !== null) this.end(this.active.route);
    this.active = { route, at: Date.now(), transport, sources: new Set([sourceId]), actions: new Map() };
    if (this.bridge.notify({ type: 'started', route, sourceId })) return true;
    this.end(route);
    return false;
  }

  snapshot(): CallRoute | null {
    const route = this.active?.route;
    return route !== undefined && this.current(route) !== null ? route : null;
  }

  valid(source: CallSource): boolean {
    return this.current(source.route)?.sources.has(source.sourceId) === true;
  }

  private current(route: CallRoute): Active | null {
    const active = this.active;
    return active !== null && sameCall(active.route, route) && this.permitted(route) && this.bridge?.available(route) === true ? active : null;
  }

  heard(route: CallRoute, text: string, sourceId: string): void {
    if (text.trim() === '' || text.length > TEXT_MAX || !this.addSource(route, sourceId)) return;
    if (this.bridge?.notify({ type: 'heard', route, text, sourceId }) !== true) this.end(route);
  }

  chat(event: Record<string, unknown>, scope: Set<string>): Record<string, string> {
    const active = this.active;
    if (active === null || event.senderVerified === false || !scope.has(active.route.agentId)) return {};
    const { route } = active;
    if (event.line !== route.line || event.from !== route.from || Date.parse(str(event.ts)) < active.at || !Number.isFinite(Date.parse(str(event.ts)))) return {};
    const sourceId = str(event.messageId);
    if (!this.addSource(route, sourceId, true)) return {};
    return { call_id: route.callId, call_generation: route.generation, call_source_id: sourceId };
  }

  bindChat(event: Record<string, unknown>, scope: Set<string>): () => Record<string, string> {
    const meta = this.chat(event, scope);
    const route = this.active?.route;
    const sourceId = meta.call_source_id;
    return () => route !== undefined && sourceId !== undefined && this.valid({ route, sourceId }) ? meta : {};
  }

  source(line: string, target: SpeechTarget, scope: Set<string>): CallSource | null {
    const route = this.active?.route;
    if (route === undefined || route.line !== line || route.callId !== target.callId || route.generation !== target.generation || !scope.has(route.agentId)) return null;
    const source = { route, sourceId: target.sourceId };
    return this.valid(source) ? source : null;
  }

  speak(line: string, target: SpeechTarget, text: string, scope: Set<string>): SpeechReceipt {
    const source = this.source(line, target, scope);
    const active = this.active;
    if (source === null || active === null) throw new Error('The call or its authorized source has ended or changed. Nothing was spoken.');
    if (text.trim() === '' || text.length > TEXT_MAX) throw new Error('Call speech needs 1 to 32000 characters of text.');
    const previous = active.actions.get(source.sourceId);
    if (previous !== undefined) {
      if (previous.text !== text) throw new Error('This source already has a different speech action. Nothing was repeated.');
      return { actionId: previous.actionId, sourceId: previous.sourceId, status: previous.status, duplicate: true };
    }
    const accessAtAcceptance = this.policy(source.route);
    if (accessAtAcceptance === 'deny') throw new Error('The owner blocked sending on this channel.');
    const action: Action = { actionId: randomUUID(), sourceId: source.sourceId, text, status: 'accepted', duplicate: false };
    active.actions.set(source.sourceId, action);
    this.status(source.route, action, 'accepted');
    const queued = active.transport.enqueue({
      actionId: action.actionId,
      text,
      isValid: () => this.valid(source) && this.policy(source.route) === accessAtAcceptance,
      status: (status) => { this.status(source.route, action, status); },
    });
    if (!queued) this.status(source.route, action, 'failed');
    else if (action.status === 'accepted') this.status(source.route, action, 'queued');
    return { actionId: action.actionId, sourceId: action.sourceId, status: action.status, duplicate: false };
  }

  end(route: CallRoute): void {
    const active = this.active;
    if (active === null || !sameCall(active.route, route)) return;
    this.active = null;
    this.bridge?.revoked(route);
    active.transport.terminate();
    for (const action of active.actions.values())
      if (!this.terminal(action.status)) this.status(route, action, 'interrupted');
    this.bridge?.notify({ type: 'ended', route });
  }

  private addSource(route: CallRoute, sourceId: string, duplicate = false): boolean {
    const active = this.current(route);
    if (active === null || !sourceValid(sourceId)) return false;
    if (active.sources.has(sourceId)) return duplicate;
    if (active.sources.size >= SOURCES_MAX) {
      log.warn('sdk-call: the call source limit was reached; ending the call');
      this.end(route);
      return false;
    }
    active.sources.add(sourceId);
    return true;
  }

  private terminal(status: SpeechStatus): boolean {
    return status === 'completed' || status === 'interrupted' || status === 'failed';
  }

  private status(route: CallRoute, action: Action, status: SpeechStatus): void {
    if (this.terminal(action.status) || (status === 'started' && action.status === 'started')) return;
    action.status = status;
    log.info({ actionId: action.actionId, status, at: Date.now() }, 'sdk-call: speech action');
    this.bridge?.notify({ type: 'speech', route, sourceId: action.sourceId, actionId: action.actionId, status });
  }
}

export const sharedCalls = new SharedCalls();
export const sharedCallsSelected = (): boolean => harnessRunner() === 'sdk';
export const openSharedCall = (route: CallRoute, sourceId: string, transport: SharedCallTransport): boolean => sharedCalls.open(route, sourceId, transport);
export const hearSharedCall = (route: CallRoute, text: string, sourceId: string): void => { sharedCalls.heard(route, text, sourceId); };
export const endSharedCall = (route: CallRoute): void => { sharedCalls.end(route); };
