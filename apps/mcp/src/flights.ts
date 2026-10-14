export class Flights<T> {
  private readonly running = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const held = this.running.get(key);
    if (held !== undefined) return held;
    const flight = work().finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, flight);
    return flight;
  }
}

export class ToolCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.at < this.ttlMs) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, value: T): void {
    const now = this.now();
    for (const [name, entry] of this.entries) if (now - entry.at >= this.ttlMs) this.entries.delete(name);
    this.entries.set(key, { at: now, value });
  }
}
