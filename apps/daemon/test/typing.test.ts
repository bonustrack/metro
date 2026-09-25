import { beforeEach, describe, expect, test } from 'bun:test';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  setTrainCallBackend((train, action) => {
    calls.push(`${train}:${action}`);
    return Promise.resolve({ result: { ok: true } });
  });
});

describe('the typing indicator', () => {
  test('one call sends one signal, nothing repeats or stops it', async () => {
    const res = await dispatchMessageTool('typing', { line: 'metro://telegram-bot/t0/-100123' });
    expect(res.isError).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(['telegram-bot:typing']);
  });

  test('WhatsApp and Discord take it, a network without it refuses before any train call', async () => {
    await dispatchMessageTool('typing', { line: 'metro://whatsapp/w0/41790000000@s.whatsapp.net' });
    await dispatchMessageTool('typing', { line: 'metro://discord-bot/d0/123456789' });
    expect(calls).toEqual(['whatsapp:typing', 'discord-bot:typing']);
    const xmtp = await dispatchMessageTool('typing', { line: 'metro://xmtp/x0/0xabc' });
    expect(xmtp.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
