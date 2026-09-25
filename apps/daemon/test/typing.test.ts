import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { startTyping, stopTyping, TYPING_MAX_MS, typingLines } from '../src/mcp/typing.ts';

const LINE = 'metro://telegram-bot/t0/-100123';
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  setTrainCallBackend((train, action, args) => {
    const on = (args as { on?: unknown }).on;
    calls.push(`${train}:${action}${typeof on === 'boolean' ? `:${String(on)}` : ''}`);
    return Promise.resolve({ result: { messageId: 'm1' } });
  });
});

afterEach(() => {
  for (const line of typingLines()) stopTyping(line);
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the typing indicator', () => {
  test('shows at once and is repeated until stopped', async () => {
    const seen: boolean[] = [];
    await startTyping('l1', (on) => (seen.push(on), Promise.resolve()), 20);
    await wait(70);
    stopTyping('l1');
    expect(seen[0]).toBe(true);
    expect(seen.filter((on) => on).length).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)).toBe(false);
    expect(typingLines()).toEqual([]);
  });

  test('stops by itself after the time limit', async () => {
    let clock = 0;
    const seen: boolean[] = [];
    await startTyping('l2', (on) => (seen.push(on), Promise.resolve()), 10, () => clock);
    clock = TYPING_MAX_MS + 1;
    await wait(40);
    expect(seen.at(-1)).toBe(false);
    expect(typingLines()).toEqual([]);
  });

  test('the tool starts it, a reply on the same chat stops it', async () => {
    const start = await dispatchMessageTool('typing', { line: LINE });
    expect(start.isError).toBeUndefined();
    expect(typingLines()).toEqual([LINE]);
    await dispatchMessageTool('reply', { line: LINE, message_id: '5', text: 'done' });
    expect(typingLines()).toEqual([]);
    expect(calls).toEqual(['telegram-bot:typing:true', 'telegram-bot:reply', 'telegram-bot:typing:false']);
  });

  test('on: false stops it, and a network without typing refuses it before any train call', async () => {
    await dispatchMessageTool('typing', { line: LINE });
    const stop = await dispatchMessageTool('typing', { line: LINE, on: false });
    expect(stop.isError).toBeUndefined();
    expect(typingLines()).toEqual([]);
    calls = [];
    const xmtp = await dispatchMessageTool('typing', { line: 'metro://xmtp/x0/0xabc' });
    expect(xmtp.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
