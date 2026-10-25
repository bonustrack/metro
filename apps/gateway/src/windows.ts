import { errMsg, log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { saveModelWindows, type ModelWindow } from '@metro-labs/connectors/db/model-calls';
import { usageOf } from '@metro-labs/inference/usage';

export const SAVE_EVERY_MS = 10_000;
const DETAIL_MAX = 256;
const LABEL_MAX = 128;
const KNOWN_MAX = 10_000;

const when = (iso: string | null): number | null => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export class WindowSaver {
  private readonly owners = new Map<string, string>();
  private readonly saved = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: () => Database,
    private readonly now: () => number = Date.now,
  ) {}

  seen(owner: string, connection: string): void {
    if (this.owners.size >= KNOWN_MAX && !this.owners.has(connection)) return;
    this.owners.set(connection, owner);
  }

  start(everyMs = SAVE_EVERY_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.save().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'gateway: usage windows could not be saved');
      });
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async save(): Promise<void> {
    for (const [connection, owner] of this.owners) {
      const usage = usageOf(connection);
      if (usage === undefined) continue;
      const windows: ModelWindow[] = usage.windows.map((w) => ({ label: w.label.slice(0, LABEL_MAX), used: w.used, resetAt: when(w.resetAt), detail: w.detail?.slice(0, DETAIL_MAX) ?? null }));
      const text = JSON.stringify(windows);
      if (this.saved.get(connection) === text) continue;
      await saveModelWindows(this.db(), owner, connection, windows, this.now());
      this.saved.set(connection, text);
    }
  }
}
