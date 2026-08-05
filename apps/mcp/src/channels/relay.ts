import {
  bufferedSince,
  currentBusSeq,
  subscribeEvents,
  type MetroEvent,
} from '../daemon/events.js';
import type { InboundRelay } from './inbound.js';

export interface ReplayLedger {
  startAt: number;
  delivered: Set<number>;
}

export const newReplayLedger = (startAt = -1): ReplayLedger => ({
  startAt,
  delivered: new Set<number>(),
});

interface ChannelRelayDeps {
  relay: InboundRelay;
  log: (...a: unknown[]) => void;
  inScope: (line: string) => boolean;
  ledger?: ReplayLedger;
}

const PENDING_MAX = 2000;

export class ChannelRelay {
  private readonly deps: ChannelRelayDeps;
  private readonly ledger: ReplayLedger;
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: ChannelRelayDeps) {
    this.deps = deps;
    this.ledger = deps.ledger ?? newReplayLedger();
  }

  start(): () => void {
    if (this.ledger.startAt < 0) this.ledger.startAt = currentBusSeq();
    return subscribeEvents((event, busSeq) => {
      this.enqueue(event, busSeq, false);
    });
  }

  replayMissed(): void {
    const missed = bufferedSince(this.ledger.startAt).filter(
      (b) => !this.ledger.delivered.has(b.busSeq),
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
    const { delivered } = this.ledger;
    if (delivered.has(busSeq)) return;
    delivered.add(busSeq);
    if (delivered.size > PENDING_MAX) {
      const cutoff = busSeq - PENDING_MAX;
      for (const s of delivered) if (s <= cutoff) delivered.delete(s);
    }
    this.chain = this.chain.then(() =>
      this.deliver(event, busSeq, replay).catch((err: unknown) => {
        this.deps.log(
          'relay: delivery step failed; chain kept alive',
          'busSeq',
          busSeq,
          'line',
          event.line,
          err,
        );
      }),
    );
  }

  private withhold(event: MetroEvent, busSeq: number): void {
    this.ledger.delivered.delete(busSeq);
    this.deps.log(
      'relay: withheld (line outside the channel session scope)',
      'busSeq',
      busSeq,
      'line',
      event.line,
    );
  }

  private async deliver(
    event: MetroEvent,
    busSeq: number,
    replay: boolean,
  ): Promise<void> {
    if (!this.deps.inScope(event.line)) {
      this.withhold(event, busSeq);
      return;
    }
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
      this.ledger.delivered.delete(busSeq);
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
