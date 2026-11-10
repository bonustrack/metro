const RUNG_MAX = 10_000;

export class Waiters {
  private readonly waiting = new Map<string, Set<() => void>>();
  private readonly rung = new Set<string>();

  wait(name: string, ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.waiting.get(name) ?? new Set<() => void>();
      this.waiting.set(name, set);
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0 && this.waiting.get(name) === set) this.waiting.delete(name);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      set.add(done);
    });
  }

  notify(name: string): void {
    for (const done of [...(this.waiting.get(name) ?? [])]) done();
  }

  ring(name: string): void {
    if (this.rung.size >= RUNG_MAX) this.rung.clear();
    this.rung.add(name);
    this.notify(name);
  }

  heard(name: string): boolean {
    return this.rung.delete(name);
  }
}
