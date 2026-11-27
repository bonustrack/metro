import { chatLine } from '@metro-labs/core/chat';
import { errMsg, log } from '@metro-labs/core/log';

const FLUSH_MAX_MS = 30_000;
const POLL_MS = 10;

let last: Promise<void> = Promise.resolve();

export function writeOut(value: unknown): void {
  last = new Promise<void>((resolve) => {
    process.stdout.write(chatLine(value), () => {
      resolve();
    });
  });
}

const emptied = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const check = (): void => {
      if (process.stdout.writableLength === 0) resolve();
      else setTimeout(check, POLL_MS);
    };
    check();
  });

export function exitFlushed(code: number, maxMs = FLUSH_MAX_MS): void {
  const exit = (): never => process.exit(code);
  setTimeout(exit, maxMs);
  last
    .then(emptied)
    .then(exit)
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'chat: the last lines could not be flushed');
      exit();
    });
}
