import { describe, expect, test } from 'bun:test';
import { trainLogLine } from '../src/stations/train-stderr.ts';

describe('a train line on stderr', () => {
  test('is a warning only when it says something went wrong', () => {
    const warn = [
      'telegram-bot[rApxe9ySNLU] poll error: telegram-bot getUpdates: Bad Gateway',
      'whatsapp[S_57AnVeOvI] baileys warn:  Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer',
      'whatsapp[S_57AnVeOvI] disconnected (code=401) — re-pair required',
      'whatsapp[S_57AnVeOvI] state connected -> connecting: The connection dropped (Stream Errored (ack), code 515).',
      'whatsapp[S_57AnVeOvI] baileys error: failed to decrypt message',
      'whatsapp: Failed to decrypt message with any known session...',
    ];
    const info = [
      'whatsapp[S_57AnVeOvI] connected',
      'whatsapp[S_57AnVeOvI] state connecting -> connected',
      'whatsapp[S_57AnVeOvI] reconnecting',
      'whatsapp[S_57AnVeOvI] send 3EB0A1 to 4179@lid: delivered',
      'xmtp train ready — 1 account(s): ceHtim0AA4I',
      'whatsapp: Closing session:',
    ];
    for (const line of warn) expect(trainLogLine(line)).toEqual({ level: 'warn', msg: line, fields: {} });
    for (const line of info) expect(trainLogLine(line)).toEqual({ level: 'info', msg: line, fields: {} });
  });

  test("a train's own log line keeps its level, message and fields, not pino's own", () => {
    const line = JSON.stringify({ level: 50, time: 1, pid: 7, hostname: 'box', name: 'metro', account: 'second', err: 'Expected }', msg: 'telegram-bot: could not load observed chats' });
    expect(trainLogLine(line)).toEqual({ level: 'error', msg: 'telegram-bot: could not load observed chats', fields: { account: 'second', err: 'Expected }' } });
    expect(trainLogLine(JSON.stringify({ level: 30, msg: 'ready' })).level).toBe('info');
    expect(trainLogLine(JSON.stringify({ level: 40, msg: 'slow' })).level).toBe('warn');
    expect(trainLogLine(JSON.stringify({ level: 20, msg: 'detail' })).level).toBe('debug');
  });

  test('a line that only looks like JSON is read as text', () => {
    expect(trainLogLine('{ not json, error')).toEqual({ level: 'warn', msg: '{ not json, error', fields: {} });
    expect(trainLogLine('{"level":"high","msg":"x"}')).toEqual({ level: 'info', msg: '{"level":"high","msg":"x"}', fields: {} });
  });
});
