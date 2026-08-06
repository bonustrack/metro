import type makeWASocket from '@whiskeysockets/baileys';

type BaileysLogger = NonNullable<
  NonNullable<Parameters<typeof makeWASocket>[0]>['logger']
>;

const MAX_DETAIL = 400;

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

type Level = (typeof LEVELS)[number];

const DEFAULT_LEVEL: Level = 'warn';

const SILENT = 'silent';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function logLevel(): Level | typeof SILENT {
  const raw = process.env.METRO_WHATSAPP_LOG_LEVEL?.trim().toLowerCase();
  if (raw === SILENT) return SILENT;
  return LEVELS.find((l) => l === raw) ?? DEFAULT_LEVEL;
}

function detail(obj: unknown): string {
  if (obj === undefined || obj === null) return '';
  if (obj instanceof Error) return ` ${oneLine(obj.message)}`;
  if (typeof obj === 'string') return ` ${oneLine(obj)}`;
  try {
    return ` ${oneLine(JSON.stringify(obj) ?? '').slice(0, MAX_DETAIL)}`;
  } catch {
    return '';
  }
}

export function baileysLogger(accountId: string): BaileysLogger {
  const level = logLevel();
  const noop = (): void => undefined;
  const write =
    (at: Level) =>
    (obj: unknown, msg?: string): void => {
      process.stderr.write(
        `whatsapp[${accountId}] baileys ${at}: ${oneLine(msg ?? '')}${detail(obj)}\n`,
      );
    };
  const method = (at: Level): ((obj: unknown, msg?: string) => void) =>
    level !== SILENT && LEVELS.indexOf(at) >= LEVELS.indexOf(level)
      ? write(at)
      : noop;
  const logger: BaileysLogger = {
    level,
    child: () => logger,
    trace: method('trace'),
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
  };
  return logger;
}
