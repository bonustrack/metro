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
    self: () => '447700900123',
    start: () => Promise.resolve(),
    sendText: record('sendText'),
    sendMedia: record('sendMedia'),
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

  test('send with an attachment calls sendMedia, not sendText', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'm1',
      action: 'send',
      args: {
        line: LINE,
        text: 'look',
        attachments: [
          {
            kind: 'image',
            path: '/cache/a.png',
            mime: 'image/png',
            name: 'a.png',
          },
        ],
      },
    });
    cap.restore();
    expect(calls.map((c) => c.method)).toEqual(['sendMedia']);
    expect(calls[0]?.args[1]).toMatchObject({
      kind: 'image',
      path: '/cache/a.png',
      mime: 'image/png',
      name: 'a.png',
      caption: 'look',
    });
  });

  test('send reports one label per attachment actually pushed', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'm2',
      action: 'send',
      args: {
        line: LINE,
        text: 'three',
        attachments: [
          { kind: 'image', path: '/cache/a.png', mime: 'image/png' },
          { kind: 'file', path: '/cache/b.pdf', mime: 'application/pdf' },
          { kind: 'video', path: '/cache/c.mp4', mime: 'video/mp4' },
        ],
      },
    });
    cap.restore();
    expect(calls).toHaveLength(3);
    expect(cap.responses[0]).toMatchObject({
      result: { attachments: ['image', 'file', 'video'] },
    });
  });

  test('only the first attachment carries the text as its caption', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'm3',
      action: 'send',
      args: {
        line: LINE,
        text: 'once',
        attachments: [
          { kind: 'image', path: '/cache/a.png' },
          { kind: 'image', path: '/cache/b.png' },
        ],
      },
    });
    cap.restore();
    expect(calls[0]?.args[1]).toMatchObject({ caption: 'once' });
    expect(calls[1]?.args[1]).not.toHaveProperty('caption');
  });

  test('reply carries attachments through the normalizer', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'm4',
      action: 'reply',
      args: {
        line: LINE,
        text: 'here',
        messageId: 'ABC',
        attachments: [{ kind: 'image', path: '/cache/a.png' }],
      },
    });
    cap.restore();
    expect(calls.map((c) => c.method)).toEqual(['sendMedia']);
    expect(calls[0]?.args[2]).toBe('ABC');
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

  test('a reaction the client refuses is an error response, never ok:true', async () => {
    const client = fakeClient(calls);
    client.sendReaction = () =>
      Promise.reject(
        new Error(
          "cannot react to message 'GHOST' in group 1@g.us: this connection never saw that message",
        ),
      );
    const handle = makeHandleCall(() => client);
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'c2',
      action: 'react',
      args: {
        line: 'metro://whatsapp/w0/1@g.us',
        messageId: 'GHOST',
        emoji: '👍',
      },
    });
    cap.restore();
    expect(cap.responses[0]).not.toMatchObject({ result: { ok: true } });
    expect((cap.responses[0] as { error?: string }).error).toContain(
      'never saw that message',
    );
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

  test('accounts reports the paired number and a wa.me link', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'g', action: 'accounts', args: {} });
    cap.restore();
    expect(cap.responses[0]).toMatchObject({
      op: 'response',
      id: 'g',
      result: {
        accounts: [
          {
            id: 'w0',
            owner: null,
            handle: '+447700900123',
            url: 'https://wa.me/447700900123',
            connected: true,
          },
        ],
      },
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

  test('an attachment the station skips is NOT reported as delivered', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'i',
      action: 'send',
      args: {
        line: LINE,
        attachments: [
          { kind: 'image', path: '/cache/a.png', mime: 'image/png' },
          { kind: 'image', mime: 'image/png' },
        ],
      },
    });
    cap.restore();
    expect(calls).toHaveLength(1);
    expect(cap.responses[0]).toMatchObject({
      result: { attachments: ['image'] },
    });
  });

  test('a kindless attachment is classified by mime for both the send and the label', async () => {
    const handle = makeHandleCall(() => fakeClient(calls));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'j',
      action: 'send',
      args: {
        line: LINE,
        attachments: [{ path: '/cache/song.mp3', mime: 'audio/mpeg' }],
      },
    });
    cap.restore();
    expect(calls[0]?.args[1]).toMatchObject({ kind: 'audio' });
    expect(cap.responses[0]).toMatchObject({ result: { attachments: ['audio'] } });
  });
});

describe('the handle is the number actually paired, not the one configured', () => {
  beforeEach(() => {
    accounts.set('w0', { id: 'w0', phone: '111' });
  });
  afterEach(() => {
    accounts.clear();
  });

  test('a socket that is not connected reports no handle and no link', async () => {
    const calls: Captured[] = [];
    const offline = { ...fakeClient(calls), self: () => null };
    const handle = makeHandleCall(() => offline);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'g', action: 'accounts', args: {} });
    cap.restore();
    expect(cap.responses[0]).toMatchObject({
      result: {
        accounts: [{ id: 'w0', handle: null, url: null, connected: false }],
      },
    });
  });

  test('the config phone is never used as the handle', async () => {
    const calls: Captured[] = [];
    const moved = { ...fakeClient(calls), self: () => '999888777' };
    const handle = makeHandleCall(() => moved);
    const cap = captureResponses();
    await handle({ op: 'call', id: 'g', action: 'accounts', args: {} });
    cap.restore();
    const [account] = (
      cap.responses[0] as { result: { accounts: { handle: string }[] } }
    ).result.accounts;
    expect(account?.handle).toBe('+999888777');
  });
});
