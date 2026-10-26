import { errMsg, log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { modelWindowsOf, saveModelWindows, type ModelWindow, type ModelWindowRow } from '@metro-labs/connectors/db/model-calls';
import { noteUsage, usageOf, type UsageWindow } from '@metro-labs/inference/usage';

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
      this.sync().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'gateway: usage windows could not be shared');
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
      await saveModelWindows(this.db(), owner, connection, windows, when(usage.at) ?? this.now());
      this.saved.set(connection, text);
    }
  }

  async sync(): Promise<void> {
    await this.save();
    await this.load();
  }

  async load(): Promise<void> {
    for (const owner of new Set(this.owners.values())) {
      const byConnection = new Map<string, ModelWindowRow[]>();
      for (const row of await modelWindowsOf(this.db(), owner)) byConnection.set(row.connection, [...(byConnection.get(row.connection) ?? []), row]);
      for (const [connection, rows] of byConnection) this.adopt(connection, rows);
    }
  }

  private adopt(connection: string, rows: ModelWindowRow[]): void {
    if (!this.owners.has(connection)) return;
    const at = Math.max(...rows.map((row) => row.at));
    const local = usageOf(connection);
    if (local !== undefined && (when(local.at) ?? 0) >= at) return;
    const windows: UsageWindow[] = rows.map((row) => ({ label: row.label, used: row.used, resetAt: row.resetAt === null ? null : new Date(row.resetAt).toISOString(), detail: row.detail }));
    noteUsage(connection, { windows, note: null, at: new Date(at).toISOString() });
    this.saved.set(connection, JSON.stringify(windows.map((w) => ({ label: w.label, used: w.used, resetAt: when(w.resetAt), detail: w.detail }))));
  }
}
