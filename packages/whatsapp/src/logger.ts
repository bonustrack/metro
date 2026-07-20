import type makeWASocket from '@whiskeysockets/baileys';

type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]>['logger'];

export function silentLogger(): BaileysLogger {
  const noop = (): void => undefined;
  const logger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  return logger;
}
