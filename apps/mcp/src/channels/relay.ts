import {
  bufferedSince,
  currentBusSeq,
  subscribeEvents,
  type MetroEvent,
} from '../daemon/events.js';
import type { InboundRelay } from './inbound.js';

interface ChannelRelayDeps {
  relay: InboundRelay;
  log: (...a: unknown[]) => void;
}

const PENDING_MAX = 2000;

export class ChannelRelay {
  private readonly deps: ChannelRelayDeps;
  private readonly pending = new Set<number>();
  private connectedAtBusSeq = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: ChannelRelayDeps) {
    this.deps = deps;
  }

  start(): () => void {
    this.connectedAtBusSeq = currentBusSeq();
    return subscribeEvents((event, busSeq) => {
      this.enqueue(event, busSeq, false);
    });
  }

  replayMissed(): void {
    const missed = bufferedSince(this.connectedAtBusSeq).filter(
      (b) => !this.pending.has(b.busSeq),
    );
    const first = missed.at(0);
    const last = missed.at(-1);
    if (!first || !last) return;
    this.deps.log(
      'relay: replay',
      `(${missed.length} events)`,
      'range',
      `${first.busSeq}..${last.busSeq}`,
    );
    for (const b of missed) this.enqueue(b.event, b.busSeq, true);
  }

  private enqueue(event: MetroEvent, busSeq: number, replay: boolean): void {
    if (this.pending.has(busSeq)) return;
    this.pending.add(busSeq);
    if (this.pending.size > PENDING_MAX) {
      const cutoff = busSeq - PENDING_MAX;
      for (const s of this.pending) if (s <= cutoff) this.pending.delete(s);
    }
    this.chain = this.chain.then(() => this.deliver(event, busSeq, replay));
  }

  private async deliver(
    event: MetroEvent,
    busSeq: number,
    replay: boolean,
  ): Promise<void> {
    this.deps.log(
      'relay: notify',
      'busSeq',
      busSeq,
      'id',
      event.id,
      'replay',
      replay,
    );
    try {
      await this.deps.relay.handleEvent(
        event as unknown as Record<string, unknown>,
        replay,
      );
    } catch (err) {
      this.pending.delete(busSeq);
      this.deps.log(
        'channel delivery failed; bounded replay on reconnect',
        'busSeq',
        busSeq,
        'line',
        event.line,
        err,
      );
    }
  }
}
