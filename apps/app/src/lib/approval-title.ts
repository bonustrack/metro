import type { Approval } from '@metro-labs/client/api/approvals';

const TITLE_WAIT_MS = 3_000;
const KEPT_MAX = 500;

function capped<V>(map: Map<string, V>): void {
  for (const key of map.keys()) {
    if (map.size <= KEPT_MAX) return;
    map.delete(key);
  }
}

export const titleKey = (approval: Pick<Approval, 'id' | 'name'>): string => `${approval.id}\u0000${approval.name}`;

export class TitleChoice {
  private readonly chosen = new Map<string, string>();
  private readonly since = new Map<string, number>();
  private readonly waitMs: number;

  constructor(waitMs = TITLE_WAIT_MS) {
    this.waitMs = waitMs;
  }

  pick(key: string, found: string | undefined, fallback: string): string | undefined {
    const kept = this.chosen.get(key);
    if (kept !== undefined) return kept;
    const title = found ?? (Date.now() - this.startedAt(key) >= this.waitMs ? fallback : undefined);
    if (title !== undefined) this.keep(key, title);
    return title;
  }

  dueIn(keys: string[]): number | null {
    const now = Date.now();
    const left = keys.filter((key) => !this.chosen.has(key)).map((key) => (this.since.get(key) ?? now) + this.waitMs - now);
    return left.length === 0 ? null : Math.max(0, Math.min(...left));
  }

  private startedAt(key: string): number {
    const known = this.since.get(key);
    if (known !== undefined) return known;
    const now = Date.now();
    this.since.set(key, now);
    capped(this.since);
    return now;
  }

  private keep(key: string, title: string): void {
    this.since.delete(key);
    this.chosen.set(key, title);
    capped(this.chosen);
  }
}

export function whenTitlesDue(choice: TitleChoice, keys: string[], due: () => void): () => void {
  const wait = choice.dueIn(keys);
  if (wait === null) return () => undefined;
  const timer = setTimeout(due, wait);
  return () => {
    clearTimeout(timer);
  };
}
