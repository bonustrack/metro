import { errMsg, log } from '@metro-labs/core/log';

export const TYPING_MAX_MS = 120_000;
const DEFAULT_REFRESH_MS = 5_000;

export type TypingCall = (on: boolean) => Promise<unknown>;

interface Held {
  timer: ReturnType<typeof setInterval>;
  call: TypingCall;
}

const held = new Map<string, Held>();

const quietly = (line: string, run: Promise<unknown>): void => {
  run.catch((err: unknown) => {
    log.debug({ line, err: errMsg(err) }, 'typing: a refresh failed');
  });
};

export function stopTyping(line: string): void {
  const current = held.get(line);
  if (current === undefined) return;
  clearInterval(current.timer);
  held.delete(line);
  quietly(line, current.call(false));
}

export async function startTyping(line: string, call: TypingCall, refreshMs = DEFAULT_REFRESH_MS, now = Date.now): Promise<void> {
  const previous = held.get(line);
  if (previous !== undefined) clearInterval(previous.timer);
  held.delete(line);
  await call(true);
  const stopAt = now() + TYPING_MAX_MS;
  const timer = setInterval(() => {
    if (now() >= stopAt) {
      stopTyping(line);
      return;
    }
    quietly(line, call(true));
  }, refreshMs);
  timer.unref();
  held.set(line, { timer, call });
}

export const typingLines = (): string[] => [...held.keys()];
