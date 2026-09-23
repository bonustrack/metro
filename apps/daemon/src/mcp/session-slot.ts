import { randomUUID } from 'node:crypto';
import { currentBusSeq } from '@metro-labs/core/events';
import { newReplayLedger } from '../channels/relay.js';
import { McpSession, channelLog } from './session.js';
import { allowedAgents, type RequestIdentity } from './request-identity.js';

export class SessionSlot {
  private session: McpSession | undefined;
  private readonly ledger = newReplayLedger();
  private started = false;

  get current(): McpSession | undefined {
    return this.session;
  }

  startInbound(): void {
    if (this.started) return;
    this.started = true;
    if (this.ledger.startAt < 0) this.ledger.startAt = currentBusSeq();
    this.session?.startChannel();
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
      onClosed: (s) => {
        if (this.session === s) this.session = undefined;
      },
    });
    this.session = session;
    if (this.started) session.startChannel();
    channelLog('session: opened', 'id', id, 'adopted', adoptId !== undefined);
    return session;
  }

  async close(): Promise<void> {
    await this.session?.close();
  }
}
