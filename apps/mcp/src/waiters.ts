export class Waiters {
  private readonly waiting = new Map<string, Set<(notified: boolean) => void>>();

  wait(name: string, ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const set = this.waiting.get(name) ?? new Set<(notified: boolean) => void>();
      this.waiting.set(name, set);
      const done = (notified: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', late);
        set.delete(done);
        if (set.size === 0 && this.waiting.get(name) === set) this.waiting.delete(name);
        resolve(notified);
      };
      const late = (): void => {
        done(false);
      };
      const timer = setTimeout(late, ms);
      signal.addEventListener('abort', late, { once: true });
      set.add(done);
    });
  }

  notify(name: string): void {
    for (const done of [...(this.waiting.get(name) ?? [])]) done(true);
  }
}
