import { createInterface } from 'node:readline';
import { isChatEffort, type ChatSender } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { missingFilesOf, turnFilesOf } from './chat-files.js';
import { exitFlushed, writeOut } from './chat-out.js';
import { ChatTurn, type ChatRequest } from './chat-turn.js';
import { runnerConfig } from './config.js';

const LINE_MAX = 256 * 1024;

function parsed(line: string): Record<string, unknown> | null {
  if (line.length > LINE_MAX) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const SENDER_MAX = 254;

const short = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' && value.length <= SENDER_MAX ? value : null);

function senderOf(value: unknown): ChatSender | null {
  const name = isRecord(value) ? short(value.name) : null;
  return name === null || !isRecord(value) ? null : { name, email: short(value.email), ...(value.admin === true ? { admin: true } : {}) };
}

function requestOf(input: Record<string, unknown> | null): ChatRequest | null {
  if (input?.t !== 'turn' || typeof input.prompt !== 'string') return null;
  const files = turnFilesOf(input.files);
  const missing = missingFilesOf(input.missing);
  if (input.prompt.trim() === '' && files.length === 0 && missing.length === 0) return null;
  return { prompt: input.prompt, from: senderOf(input.from), resume: typeof input.resume === 'string' && input.resume !== '' ? input.resume : null, files, missing, effort: isChatEffort(input.effort) ? input.effort : null };
}

const turn = new ChatTurn(writeOut);
let started = false;

function stop(): void {
  turn.stop().catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'chat: stop failed');
  });
}

function start(request: ChatRequest): void {
  started = true;
  Promise.resolve()
    .then(() => turn.run(runnerConfig(), request))
    .catch((err: unknown) => {
      log.error({ err: errMsg(err) }, 'chat: the turn could not run');
      writeOut({ t: 'done', state: 'error', error: 'The agent could not start this reply.' });
    })
    .finally(() => {
      exitFlushed(0);
    });
}

function control(input: Record<string, unknown> | null): void {
  if (input?.t === 'stop') stop();
  else if (input?.t === 'answer' && typeof input.id === 'string' && typeof input.allow === 'boolean') turn.answer(input.id, input.allow);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const input = parsed(line);
  if (started) {
    control(input);
    return;
  }
  const request = requestOf(input);
  if (request === null) {
    started = true;
    writeOut({ t: 'done', state: 'error', error: 'Metro sent no message to answer.' });
    exitFlushed(2);
    return;
  }
  start(request);
});
lines.on('close', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop);
