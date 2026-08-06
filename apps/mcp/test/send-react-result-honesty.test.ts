import { afterEach, describe, expect, test } from 'bun:test';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { setTrainCallBackend } from '../src/daemon/train-call.ts';
import type { TrainCallResponse } from '../src/daemon/protocol.ts';

const WHATSAPP = 'metro://whatsapp/w0/111@s.whatsapp.net';
const XMTP = 'metro://xmtp/x0/0xabc';
const LINE = 'metro://line/l0/U123';

interface Call {
  action: string;
  args: Record<string, unknown>;
}

function stubTrain(reply: (call: Call) => TrainCallResponse): Call[] {
  const calls: Call[] = [];
  setTrainCallBackend((_train, action, args) => {
    const call = { action, args: args as Record<string, unknown> };
    calls.push(call);
    return Promise.resolve(reply(call));
  });
  return calls;
}

const textOf = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

afterEach(() => {
  setTrainCallBackend(() => Promise.resolve({ result: null }));
});

describe('a text send is reported from the station response, not from the request', () => {
  test('a station that answers with nothing at all is an error, not `sent: text`', async () => {
    stubTrain(() => ({ result: null }));
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('whatsapp did not confirm the text');
    expect(textOf(res)).not.toContain('sent:');
  });

  test('a station that answers with an empty object is an error too', async () => {
    stubTrain(() => ({ result: {} }));
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('sent:');
  });

  test('a station that answers with an empty message id is an error', async () => {
    stubTrain(() => ({ result: { messageId: '', account: 'w0' } }));
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('sent:');
  });

  test('the reported id is the station message id, never anything from the request', async () => {
    stubTrain(() => ({ result: { messageId: '3EB0269C', account: 'w0' } }));
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
    });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('sent: text (id 3EB0269C)');
  });

  test('a numeric message id is carried through as a string', async () => {
    stubTrain(() => ({ result: { messageId: 4321, account: 't0' } }));
    const res = await dispatchMessageTool('send', {
      line: 'metro://telegram/t0/-100123',
      text: 'hi',
    });
    expect(textOf(res)).toBe('sent: text (id 4321)');
  });

  test('a station with no message id to give may acknowledge instead', async () => {
    stubTrain(() => ({ result: { ok: true, account: 'l0' } }));
    const res = await dispatchMessageTool('send', { line: LINE, text: 'hi' });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('sent: text');
  });

  test('the native send path is held to the same rule', async () => {
    stubTrain(() => ({ result: null }));
    const res = await dispatchMessageTool('send', { line: XMTP, text: 'hi' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('xmtp did not confirm the text');
  });

  test('the native send path reports the id the station returned', async () => {
    stubTrain(() => ({ result: { messageId: 'x-1' } }));
    const res = await dispatchMessageTool('send', { line: XMTP, text: 'hi' });
    expect(textOf(res)).toBe('sent: text (id x-1)');
  });
});

describe('every addressed verb is reported from the station response', () => {
  const VERBS = [
    { name: 'react', args: { message_id: 'ABC', emoji: '👍' }, success: 'reacted' },
    {
      name: 'unreact',
      args: { message_id: 'ABC', emoji: '👍' },
      success: 'reaction removed',
    },
    { name: 'reply', args: { message_id: 'ABC', text: 'yo' }, success: 'replied' },
    { name: 'edit', args: { message_id: 'ABC', text: 'yo' }, success: 'edited' },
    { name: 'delete', args: { message_id: 'ABC' }, success: 'deleted' },
  ];

  for (const v of VERBS) {
    test(`${v.name}: a station that answers with nothing is an error, not '${v.success}'`, async () => {
      stubTrain(() => ({ result: null }));
      const res = await dispatchMessageTool(v.name, {
        line: WHATSAPP,
        ...v.args,
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(`whatsapp did not confirm the ${v.name}`);
      expect(textOf(res)).not.toBe(v.success);
    });

    test(`${v.name}: an acknowledgement with no id reports '${v.success}'`, async () => {
      stubTrain(() => ({ result: { ok: true, account: 'w0' } }));
      const res = await dispatchMessageTool(v.name, {
        line: WHATSAPP,
        ...v.args,
      });
      expect(res.isError).toBeUndefined();
      expect(textOf(res)).toBe(v.success);
    });

    test(`${v.name}: a station message id is carried through`, async () => {
      stubTrain(() => ({ result: { messageId: '3EB041', account: 'w0' } }));
      const res = await dispatchMessageTool(v.name, {
        line: WHATSAPP,
        ...v.args,
      });
      expect(res.isError).toBeUndefined();
      expect(textOf(res)).toBe(`${v.success} (id 3EB041)`);
    });
  }
});

describe('the regression that started this', () => {
  test('a whatsapp text send whose ack was a 463 is an error, never a success', async () => {
    stubTrain(() => ({
      error:
        'metro send whatsapp: whatsapp_account_restricted: 463, the account is time-locked',
    }));
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('463');
    expect(textOf(res)).not.toContain('sent:');
  });

  test('a non-empty request text can no longer produce a success on its own', async () => {
    const calls = stubTrain(() => ({ result: { account: 'w0' } }));
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'a message the station never acknowledged',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.text).toBe(
      'a message the station never acknowledged',
    );
    expect(res.isError).toBe(true);
  });
});
