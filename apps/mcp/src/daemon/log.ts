import { writeSync } from 'node:fs';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

const stream = process.stderr.isTTY
  ? pinoPretty({
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname,name',
      destination: 2,
    })
  : pino.destination(2);

export const log = pino(
  { base: { name: 'metro' }, level: process.env.METRO_LOG_LEVEL ?? 'info' },
  stream,
);

export const logFatalSync = (
  fields: Record<string, unknown>,
  msg: string,
): void => {
  const line = JSON.stringify({
    level: 60,
    time: Date.now(),
    name: 'metro',
    ...fields,
    msg,
  });
  try {
    writeSync(2, `${line}\n`);
  } catch {
    return;
  }
};

export const errMsg = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err)
    return String(err.message);
  return String(err);
};
