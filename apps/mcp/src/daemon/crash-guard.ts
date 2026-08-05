import { errMsg, log, logFatalSync } from './log.js';

export type CrashKind = 'unhandledRejection' | 'uncaughtException';

const seen: Record<CrashKind, number> = {
  unhandledRejection: 0,
  uncaughtException: 0,
};

let ready = false;
let installed = false;

export function markDaemonReady(): void {
  ready = true;
}

export function crashCount(kind: CrashKind): number {
  return seen[kind];
}

function fields(kind: CrashKind, err: unknown): Record<string, unknown> {
  return {
    crash: kind,
    seen: seen[kind],
    err: errMsg(err),
    errType: err instanceof Error ? err.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
  };
}

function reportCrash(kind: CrashKind, err: unknown): void {
  seen[kind] += 1;
  if (!ready) {
    logFatalSync(fields(kind, err), 'daemon: failed before it was ready');
    process.exit(1);
  }
  log.error(fields(kind, err), 'daemon: kept running through a crash');
}

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason: unknown) => {
    reportCrash('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err: unknown) => {
    reportCrash('uncaughtException', err);
  });
}
