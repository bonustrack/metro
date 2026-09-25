import { beforeEach, describe, expect, test } from 'bun:test';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  setTrainCallBackend((train, action) => {
    calls.push(`${train}:${action}`);
    return Promise.resolve({ result: { messageId: 'm1' } });
  });
});

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n');

describe('a message verb the line station does not declare', () => {
  test('read on a telegram-bot line is refused before any train call', async () => {
    const res = await dispatchMessageTool('read', { line: 'metro://telegram-bot/t0/-100123' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('telegram-bot does not support read; it supports send, reply, react, unreact, edit, delete, typing.');
    expect(calls).toEqual([]);
  });

  test('edit and delete on an xmtp line are refused before any train call', async () => {
    const edit = await dispatchMessageTool('edit', { line: 'metro://xmtp/x0/0xabc', message_id: 'm0', text: 'hi' });
    expect(edit.isError).toBe(true);
    expect(text(edit)).toBe('xmtp does not support edit; it supports send, reply, react, unreact, read.');
    const del = await dispatchMessageTool('delete', { line: 'metro://xmtp/x0/0xabc', message_id: 'm0' });
    expect(text(del)).toContain('xmtp does not support delete');
    expect(calls).toEqual([]);
  });

  test('a declared verb still reaches the train', async () => {
    const res = await dispatchMessageTool('edit', { line: 'metro://telegram-bot/t0/-100123', message_id: 'm0', text: 'hi' });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(['telegram-bot:edit']);
  });
});
