import {
  bufferedSince,
  subscribeEvents,
  type MetroEvent,
} from '../daemon/events.js';
import type { InboundRelay } from './inbound.js';

interface ChannelRelayDeps {
  relay: InboundRelay;
  log: (...a: unknown[]) => void;
}

export class ChannelRelay {
  private readonly deps: ChannelRelayDeps;
  private deliveredBusSeq = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: ChannelRelayDeps) {
    this.deps = deps;
  }

  start(): () => void {
    return subscribeEvents((event, busSeq) => {
      this.enqueue(event, busSeq, false);
    });
  }

  replayMissed(): void {
    for (const b of bufferedSince(this.deliveredBusSeq))
      this.enqueue(b.event, b.busSeq, true);
  }

  private enqueue(event: MetroEvent, busSeq: number, replay: boolean): void {
    this.chain = this.chain.then(() => this.deliver(event, busSeq, replay));
  }

  private async deliver(
    event: MetroEvent,
    busSeq: number,
    replay: boolean,
  ): Promise<void> {
    if (busSeq <= this.deliveredBusSeq) return;
    const contiguous = busSeq === this.deliveredBusSeq + 1;
    try {
      await this.deps.relay.handleEvent(
        event as unknown as Record<string, unknown>,
        replay,
      );
      if (contiguous) this.deliveredBusSeq = busSeq;
    } catch (err) {
      this.deps.log(
        'channel delivery failed; will replay on reconnect',
        'busSeq',
        busSeq,
        'line',
        event.line,
        err,
      );
    }
  }
}
