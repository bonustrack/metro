import type makeWASocket from '@whiskeysockets/baileys';

type BaileysLogger = NonNullable<
  NonNullable<Parameters<typeof makeWASocket>[0]>['logger']
>;

const MAX_DETAIL = 400;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

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
  const noop = (): void => undefined;
  const write =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      process.stderr.write(
        `whatsapp[${accountId}] baileys ${level}: ${oneLine(msg ?? '')}${detail(obj)}\n`,
      );
    };
  const logger: BaileysLogger = {
    level: 'warn',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: write('warn'),
    error: write('error'),
  };
  return logger;
}
