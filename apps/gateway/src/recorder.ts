import { errMsg, log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { isUndefinedTable } from '@metro-labs/connectors/db/errors';
import { recordModelCalls, type NewModelCall } from '@metro-labs/connectors/db/model-calls';

export const FLUSH_MS = 2_000;
export const BATCH_MAX = 100;
const QUEUE_MAX = 10_000;

export class CallLog {
  private rows: NewModelCall[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private missing = false;

  constructor(
    private readonly db: () => Database,
    private readonly everyMs = FLUSH_MS,
  ) {}

  add(row: NewModelCall): void {
    if (this.rows.length >= QUEUE_MAX) return;
    this.rows.push(row);
    if (this.rows.length >= BATCH_MAX) this.flush();
    else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.everyMs);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.rows;
    this.rows = [];
    if (batch.length === 0) return;
    this.writing = this.writing.then(() => this.write(batch));
  }

  async drain(): Promise<void> {
    this.flush();
    await this.writing;
  }

  private async write(batch: NewModelCall[]): Promise<void> {
    try {
      await recordModelCalls(this.db(), batch);
      if (this.missing) log.info('gateway: recording model calls again');
      this.missing = false;
    } catch (err) {
      if (isUndefinedTable(err)) {
        if (!this.missing) log.warn('gateway: the model_calls table does not exist yet, so calls are not recorded until api.metro.box migrates');
        this.missing = true;
        return;
      }
      log.warn({ rows: batch.length, err: errMsg(err) }, 'gateway: model calls could not be recorded');
    }
  }
}
