import { randomUUID } from 'node:crypto';
import { currentBusSeq } from '@metro-labs/core/events';
import { newReplayLedger } from '../channels/relay.js';
import { McpSession, channelLog } from './session.js';
import { allowedAgents, type RequestIdentity } from './request-identity.js';

export class SessionSlot {
  private session: McpSession | undefined;
  private readonly ledger = newReplayLedger();
  private started = false;
  private live: boolean;

  constructor(live = true) {
    this.live = live;
  }

  get current(): McpSession | undefined {
    return this.session;
  }

  get liveEvents(): boolean {
    return this.live;
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

  async open(
    identity: RequestIdentity,
    adoptId?: string,
  ): Promise<McpSession> {
    await this.session?.close();
    if (this.ledger.startAt < 0) this.ledger.startAt = currentBusSeq();
    const id = adoptId ?? randomUUID();
    const session = await McpSession.open({
      id,
      scope: allowedAgents(identity),
      adopted: adoptId !== undefined,
      ledger: this.ledger,
      live: () => this.live,
      onClosed: (s) => {
        if (this.session === s) this.session = undefined;
      },
    });
    this.session = session;
    if (this.started && this.live) session.startChannel();
    channelLog('session: opened', 'id', id, 'adopted', adoptId !== undefined);
    return session;
  }

  async close(): Promise<void> {
    await this.session?.close();
  }
}
