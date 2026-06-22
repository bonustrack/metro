export const KEEPALIVE_INTERVAL_MS = 25_000;

interface KeepaliveDeps {
  ping: () => Promise<unknown>;
  log: (...a: unknown[]) => void;
  intervalMs?: number;
}

export class Keepalive {
  private readonly deps: KeepaliveDeps;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: KeepaliveDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    try {
      await this.deps.ping();
    } catch (e) {
      this.deps.log('keepalive ping failed', e);
    }
  }
}
