import { watch, type FSWatcher } from 'node:fs';
import { errMsg, log } from '@metro-labs/core/log';

const DEBOUNCE_MS = 300;
const FILE = 'connectors.json';

export class ConnectorWatch {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.dir, (_event, file) => {
        if (file === null || file === FILE) this.schedule();
      });
      this.watcher.on('error', (err: unknown) => {
        log.warn({ err: errMsg(err) }, 'connectors: watcher failed; the plugin list refreshes at the next start');
      });
      this.watcher.unref();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'connectors: could not watch the agents dir');
    }
    this.fire();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, DEBOUNCE_MS);
    this.timer.unref();
  }

  private fire(): void {
    try {
      this.onChange();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'connectors: change handler failed');
    }
  }
}
