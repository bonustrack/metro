import { errMsg, log } from '@metro-labs/core/log';
import type { Connection } from '@metro-labs/inference/model-config';
import { probes, probeUsage, PROBE_EVERY_MS, type ProbeDeps } from '@metro-labs/inference/probes';
import { mayProbe } from '@metro-labs/inference/usage';

const TICK_MS = 60_000;
const FORGET_MS = 60 * 60_000;
const TRACKED_MAX = 5_000;

interface Tracked {
  owner: string;
  conn: Connection;
  at: number;
}

export interface ProbeSink {
  seen: (owner: string, connection: string) => void;
}

export class UsageProbes {
  private readonly tracked = new Map<string, Tracked>();
  private readonly failing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: ProbeSink,
    private readonly deps: ProbeDeps = {},
    private readonly now: () => number = Date.now,
  ) {}

  track(owner: string, connections: Connection[]): void {
    for (const conn of connections) {
      if (!probes(conn)) continue;
      if (this.tracked.size >= TRACKED_MAX && !this.tracked.has(conn.id)) return;
      this.tracked.set(conn.id, { owner, conn, at: this.now() });
      this.sink.seen(owner, conn.id);
      this.probe(conn);
    }
  }

  start(everyMs = TICK_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.tick();
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const now = this.now();
    for (const [id, held] of this.tracked) {
      if (now - held.at > FORGET_MS) this.tracked.delete(id);
      else this.probe(held.conn);
    }
  }

  private probe(conn: Connection): void {
    if (!mayProbe(conn.id, this.now(), PROBE_EVERY_MS)) return;
    probeUsage(conn, this.deps, new Date(this.now())).then(
      () => {
        this.failing.delete(conn.id);
      },
      (err: unknown) => {
        if (!this.failing.has(conn.id)) log.warn({ connection: conn.id, provider: conn.provider, err: errMsg(err) }, 'gateway: an account would not report its usage, later failures stay quiet until it does');
        this.failing.add(conn.id);
      },
    );
  }
}
