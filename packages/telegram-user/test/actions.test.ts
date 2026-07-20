import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeHandleCall } from '../src/actions.ts';
import { accounts } from '../src/accounts.ts';
import type { UserClient } from '../src/client.ts';

const LINE = 'metro://telegram-user/default/12345';

interface Captured {
  method: string;
  args: unknown[];
}

function fakeClient(calls: Captured[]): UserClient {
  const tg = {
    resolvePeer: (chatId: number): Promise<unknown> => {
      calls.push({ method: 'resolvePeer', args: [chatId] });
      return Promise.resolve({ peer: chatId });
    },
    sendText: (...args: unknown[]): Promise<{ id: number }> => {
      calls.push({ method: 'sendText', args });
      return Promise.resolve({ id: 999 });
    },
    sendReaction: (...args: unknown[]): Promise<null> => {
      calls.push({ method: 'sendReaction', args });
      return Promise.resolve(null);
    },
    editMessage: (...args: unknown[]): Promise<void> => {
      calls.push({ method: 'editMessage', args });
      return Promise.resolve();
    },
    deleteMessagesById: (...args: unknown[]): Promise<void> => {
      calls.push({ method: 'deleteMessagesById', args });
      return Promise.resolve();
    },
    getHistory: (...args: unknown[]): Promise<unknown[]> => {
      calls.push({ method: 'getHistory', args });
      return Promise.resolve([
        {
          id: 9,
          date: new Date('2026-06-21T00:00:00.000Z'),
          text: 'newest',
          sender: { id: 222 },
          media: null,
        },
        {
          id: 8,
          date: new Date('2026-06-21T00:00:00.000Z'),
          text: 'older',
          sender: { id: 111 },
          media: null,
        },
      ]);
    },
    sendMedia: (...args: unknown[]): Promise<{ id: number }> => {
      calls.push({ method: 'sendMedia', args });
      return Promise.resolve({ id: 777 });
    },
  };
  return { account: { id: 'default', session: 's' }, tg } as unknown as UserClient;
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

describe('telegram-user outbound handlers', () => {
  let calls: Captured[];

  beforeEach(() => {
    calls = [];
    accounts.set('default', { id: 'default', session: 's' });
  });
  afterEach(() => {
    accounts.clear();
  });

  test('send resolves peer and calls sendText, returns messageId+account', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'a', action: 'send', args: { line: LINE, text: 'hello' } });
    cap.restore();
    expect(calls[0]).toEqual({ method: 'resolvePeer', args: [12345] });
    expect(calls[1]?.method).toBe('sendText');
    expect(calls[1]?.args[1]).toBe('hello');
    expect(calls[1]?.args[2]).toBeUndefined();
    expect(cap.responses[0]).toMatchObject({
      op: 'response',
      id: 'a',
      result: { messageId: '999', account: 'default' },
    });
  });

  test('reply normalizes to send with replyTo param', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'b', action: 'reply', args: { line: LINE, text: 'yo', replyTo: '42' } });
    cap.restore();
    expect(calls[1]?.method).toBe('sendText');
    expect(calls[1]?.args[2]).toEqual({ replyTo: 42 });
  });

  test('react shapes chatId/message/emoji', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'c', action: 'react', args: { line: LINE, messageId: '7', emoji: '👍' } });
    cap.restore();
    expect(calls[0]).toEqual({
      method: 'sendReaction',
      args: [{ chatId: 12345, message: 7, emoji: '👍' }],
    });
  });

  test('unreact normalizes to react with null emoji', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'd', action: 'unreact', args: { line: LINE, messageId: '7' } });
    cap.restore();
    expect(calls[0]).toEqual({
      method: 'sendReaction',
      args: [{ chatId: 12345, message: 7, emoji: null }],
    });
  });

  test('edit shapes chatId/message/text', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'e', action: 'edit', args: { line: LINE, messageId: '7', text: 'new' } });
    cap.restore();
    expect(calls[0]).toEqual({
      method: 'editMessage',
      args: [{ chatId: 12345, message: 7, text: 'new' }],
    });
  });

  test('delete revokes for everyone', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'f', action: 'delete', args: { line: LINE, messageId: '7' } });
    cap.restore();
    expect(calls[0]).toEqual({
      method: 'deleteMessagesById',
      args: [12345, [7], { revoke: true }],
    });
  });

  test('read calls getHistory and returns the xmtp-shaped result', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'g',
      action: 'read',
      args: { line: LINE, limit: 5 },
    });
    cap.restore();
    expect(calls).toContainEqual({ method: 'getHistory', args: [12345, { limit: 5 }] });
    expect(cap.responses[0]).toMatchObject({
      op: 'response',
      id: 'g',
      result: {
        line: LINE,
        count: 2,
        messages: [
          { id: '8', from: 'metro://telegram-user/default/user/111', text: 'older' },
          { id: '9', from: 'metro://telegram-user/default/user/222', text: 'newest' },
        ],
      },
    });
  });

  test('read with before pages older history via getHistory offset', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'g2',
      action: 'read',
      args: { line: LINE, limit: 5, before: '8' },
    });
    cap.restore();
    expect(calls).toContainEqual({
      method: 'getHistory',
      args: [12345, { limit: 5, offset: { id: 8, date: 0 } }],
    });
  });

  test('send with canonical attachment calls sendMedia and returns its id', async () => {
    const client = fakeClient(calls);
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'h',
      action: 'send',
      args: {
        line: LINE,
        text: 'cap',
        attachments: [{ url: '/cache/a.jpg', mime: 'image/jpeg', name: 'a.jpg' }],
      },
    });
    cap.restore();
    const media = calls.find((c) => c.method === 'sendMedia');
    expect(media).toBeDefined();
    expect(cap.responses[0]).toMatchObject({
      op: 'response',
      id: 'h',
      result: { messageId: '777', account: 'default' },
    });
  });
});
