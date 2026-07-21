import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeHandleCall } from '../src/actions.ts';
import { accounts } from '../src/accounts.ts';
import type { WAClient } from '../src/client.ts';

const JID = '111@s.whatsapp.net';
const LINE = `metro://whatsapp/w0/${JID}`;

interface Captured {
  method: string;
  args: unknown[];
}

function fakeClient(calls: Captured[]): WAClient {
  const record =
    (method: string) =>
    (...args: unknown[]): Promise<string> => {
      calls.push({ method, args });
      return Promise.resolve('MID');
    };
  return {
    account: { id: 'w0', phone: '111' },
    start: () => Promise.resolve(),
    sendText: record('sendText'),
    sendReaction: record('sendReaction'),
    editMessage: record('editMessage'),
    deleteMessage: record('deleteMessage'),
    disconnect: () => Promise.resolve(),
  } as unknown as WAClient;
}

function captureResponses(): { responses: unknown[]; restore: () => void } {
  const responses: unknown[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const parsed = JSON.parse(String(chunk)) as { op?: string };
    if (parsed.op === 'response') responses.push(parsed);
    return true;
  }) as typeof process.stdout.write;
  return { responses, restore: () => void (process.stdout.write = orig) };
}

describe('whatsapp outbound handlers', () => {
  let calls: Captured[];

  beforeEach(() => {
    calls = [];
    accounts.set('w0', { id: 'w0', phone: '111' });
  });
  afterEach(() => {
    accounts.clear();
  });

  test('send calls sendText, returns messageId+account', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'a', action: 'send', args: { line: LINE, text: 'hi' } });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'sendText', args: [JID, 'hi', undefined] });
    expect(cap.responses[0]).toMatchObject({
      op: 'response',
      id: 'a',
      result: { messageId: 'MID', account: 'w0' },
    });
  });

  test('reply normalizes to send with the quoted message id', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'b',
      action: 'reply',
      args: { line: LINE, text: 'yo', messageId: 'ABC' },
    });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'sendText', args: [JID, 'yo', 'ABC'] });
  });

  test('react shapes jid/message/emoji', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'c', action: 'react', args: { line: LINE, messageId: 'ABC', emoji: '👍' } });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'sendReaction', args: [JID, 'ABC', '👍'] });
  });

  test('unreact normalizes to react with empty emoji', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'd', action: 'unreact', args: { line: LINE, messageId: 'ABC' } });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'sendReaction', args: [JID, 'ABC', ''] });
  });

  test('edit shapes jid/message/text', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'e', action: 'edit', args: { line: LINE, messageId: 'ABC', text: 'new' } });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'editMessage', args: [JID, 'ABC', 'new'] });
  });

  test('delete shapes jid/message', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'f', action: 'delete', args: { line: LINE, messageId: 'ABC' } });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'deleteMessage', args: [JID, 'ABC'] });
  });

  test('accounts lists configured ids', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'g', action: 'accounts', args: {} });
    cap.restore();
    expect(cap.responses[0]).toMatchObject({
      op: 'response',
      id: 'g',
      result: { accounts: [{ id: 'w0', owner: null }] },
    });
  });

  test('bad line is reported as an error response', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'h', action: 'send', args: { line: 'metro://telegram/1', text: 'x' } });
    cap.restore();
    expect(cap.responses[0]).toMatchObject({ op: 'response', id: 'h' });
    expect((cap.responses[0] as { error?: string }).error).toContain('bad line');
  });
});
