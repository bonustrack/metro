import { randomUUID } from 'node:crypto';
import { currentBusSeq } from '@metro-labs/core/events';
import { errMsg } from '@metro-labs/core/log';
import { newReplayLedger } from '../channels/relay.js';
import { McpSession, channelLog, type SessionKind } from './session.js';
import { allowedAgents, type RequestIdentity } from './request-identity.js';
import { diagnosticTag, type SessionDiagnostic, type SlotDiagnostic } from './diagnostics.js';

interface SlotReplacement {
  at: string;
  reason: 'initialize' | 'adopt';
  tag: string;
  scope: Set<string>;
  previousScope: Set<string>;
  previous: SessionDiagnostic | null;
}

const sharesScope = (left: Set<string>, right: Set<string>): boolean => [...left].some((id) => right.has(id));

export class SessionSlot {
  private session: McpSession | undefined;
  private readonly ledger = newReplayLedger();
  private started = false;
  private live: boolean;
  private changing: Promise<void> = Promise.resolve();
  private readonly replacements: SlotReplacement[] = [];

  constructor(
    live = true,
    private readonly kind: SessionKind = 'chat',
  ) {
    this.live = live;
  }

  get current(): McpSession | undefined {
    return this.session;
  }

  get liveEvents(): boolean {
    return this.live;
  }

  diagnostics(scope: Set<string>): SlotDiagnostic {
    return {
      started: this.started,
      liveEvents: this.live,
      current: this.session !== undefined && sharesScope(scope, this.session.scope) ? this.session.diagnostics() : null,
      replacements: this.replacements.filter((replacement) => sharesScope(scope, replacement.scope)).map((replacement) => ({
        at: replacement.at,
        reason: replacement.reason,
        tag: replacement.tag,
        previous: sharesScope(scope, replacement.previousScope) ? replacement.previous : null,
      })),
    };
  }

  startInbound(): void {
    if (this.started) return;
    this.started = true;
    if (this.ledger.startAt < 0) this.ledger.startAt = currentBusSeq();
    if (this.live) this.session?.startChannel();
  }

  setLive(on: boolean): void {
    if (this.live === on) return;
    this.live = on;
    channelLog('inbound: live events', on ? 'on' : 'off');
    if (!on) {
      this.session?.stopChannel();
      this.session?.relay.dropPending();
      return;
    }
    this.ledger.startAt = currentBusSeq();
    if (this.started) this.session?.startChannel();
  }

  open(identity: RequestIdentity, adoptId?: string): Promise<McpSession> {
    return this.change(() => this.replace(identity, adoptId));
  }

  private change<T>(run: () => Promise<T>): Promise<T> {
    const changed = this.changing.then(run);
    this.changing = changed.then(() => undefined).catch((err: unknown) => {
      channelLog('session: change failed', errMsg(err));
    });
    return changed;
  }

  private previousSlot(): Pick<SlotReplacement, 'previous' | 'previousScope'> {
    return {
      previous: this.session?.diagnostics() ?? null,
      previousScope: this.session?.scope ?? new Set<string>(),
    };
  }

  private recordReplacement(session: McpSession, adoptId: string | undefined, previous: Pick<SlotReplacement, 'previous' | 'previousScope'>): void {
    this.replacements.push({
      at: new Date().toISOString(),
      reason: adoptId === undefined ? 'initialize' : 'adopt',
      tag: diagnosticTag(session.id),
      scope: session.scope,
      ...previous,
    });
    if (this.replacements.length > 8) this.replacements.shift();
  }

  private async replace(identity: RequestIdentity, adoptId?: string): Promise<McpSession> {
    if (adoptId !== undefined && this.session?.id === adoptId) return this.session;
    const previous = this.previousSlot();
    await this.session?.close();
    if (this.ledger.startAt < 0) this.ledger.startAt = currentBusSeq();
    const id = adoptId ?? randomUUID();
    const session = await McpSession.open({
      kind: this.kind,
      id,
      scope: allowedAgents(identity),
      adopted: adoptId !== undefined,
      ledger: this.ledger,
      live: () => this.live,
      onClosed: (s) => {
        if (this.session === s) this.session = undefined;
        s.channel.whenIdle().then(() => {
          if (this.session?.streamAttached) this.session.replayMissed();
        }).catch((err: unknown) => {
          channelLog('session: handoff replay failed', errMsg(err));
        });
      },
    });
    this.session = session;
    this.recordReplacement(session, adoptId, previous);
    if (this.started && this.live) session.startChannel();
    channelLog('session: opened', 'id', id, 'kind', this.kind, 'adopted', adoptId !== undefined);
    return session;
  }

  close(): Promise<void> {
    return this.change(async () => {
      await this.session?.close();
    });
  }
}
