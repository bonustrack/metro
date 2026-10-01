import { beforeEach, describe, expect, test } from 'bun:test';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { TOOL_DEFS } from '../src/mcp/tool-catalog.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';

interface Call {
  train: string;
  action: string;
  args: unknown;
}

let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  setTrainCallBackend((train, action, args) => {
    calls.push({ train, action, args });
    return Promise.resolve({ result: { messageId: 'frame-1' } });
  });
});

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n');
const line = 'metro://xmtp/x0/group1';
const frame = { title: 'Deploy', widget: { type: 'Card', children: [{ type: 'Title', value: 'Deploy?' }] } };

describe('a frame rides on send, with no tool of its own', () => {
  test('send_frame is gone and send takes a frame', () => {
    expect(TOOL_DEFS.map((d) => d.name)).not.toContain('send_frame');
    const send = TOOL_DEFS.find((d) => d.name === 'send');
    expect(Object.keys((send?.inputSchema as { properties: object }).properties)).toContain('frame');
  });

  test('an XMTP send with only a frame reaches the train send and names the frame', async () => {
    const res = await dispatchMessageTool('send', { line, frame });
    expect(text(res)).toMatch(/^sent: frame .+ message_id: frame-1$/);
    expect(calls).toEqual([{ train: 'xmtp', action: 'send', args: { line, frame } }]);
  });

  test('text and a frame go in one train call', async () => {
    const res = await dispatchMessageTool('send', { line, text: 'Here it is', reply_to: 'm0', frame });
    expect(text(res)).toMatch(/^sent: text, frame .+ message_id: frame-1$/);
    expect(calls).toEqual([{ train: 'xmtp', action: 'send', args: { line, text: 'Here it is', replyTo: 'm0', frame } }]);
  });

  test('a station without frames refuses before any train call', async () => {
    const res = await dispatchMessageTool('send', { line: 'metro://telegram-bot/t0/-100123', text: 'hi', frame });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('telegram-bot cannot send a frame; frames are Stage (XMTP) only');
    expect(calls).toEqual([]);
  });

  test('a send with nothing to send names the frame too', async () => {
    const res = await dispatchMessageTool('send', { line });
    expect(text(res)).toContain('send requires `text`, `attachments` or `frame`');
    expect(calls).toEqual([]);
  });
});
