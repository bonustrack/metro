import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.ts';
import { NotFoundError } from '../src/api/client.js';
import { fetchChatFile, uploadChatFile } from '../src/api/chat-files.js';
import { postChatMessage, startChat, toChatMessage } from '../src/api/chats.js';
import { installTestAccount } from './account-fixture.js';

const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  method: string;
  ticket: string | null;
  authorization: string | null;
  body: unknown;
}

let seen: Seen[] = [];

function serve(answer: () => Response): void {
  seen = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? 'GET', ticket: headers.get('x-metro-chat-ticket'), authorization: headers.get('authorization'), body: init?.body ?? null });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MESSAGE = { id: 'msg00000001', seq: 1, role: 'user', text: '', files: [{ id: 'fileAAAAAAA', name: 'plan.pdf', type: 'application/pdf', size: 3 }] };

beforeEach(() => {
  clearAccount();
  installTestAccount();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
});

describe('the bytes of a chat file go to the box, never through a url', () => {
  test('an upload is a PUT of the bytes with the send ticket in a header', async () => {
    serve(() => json({ ok: true }));
    const bytes = new Blob(['abc']);
    await uploadChatFile('emma.ts.net', 'msg00000001', 'fileAAAAAAA', 'send.ticket.sig', bytes);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://emma.ts.net/api/chat/files/msg00000001/fileAAAAAAA', method: 'PUT', ticket: 'send.ticket.sig', body: bytes });
    expect(seen[0]?.authorization?.startsWith('Bearer ')).toBe(true);
    expect(seen[0]?.url.includes('ticket')).toBe(false);
  });

  test('a file is read with the view ticket in a header, and a file the box no longer has is a 404', async () => {
    serve(() => new Response('png-bytes', { status: 200, headers: { 'content-type': 'image/png' } }));
    const blob = await fetchChatFile('emma.ts.net', 'chat0000001', 'fileAAAAAAA', 'view.ticket.sig');
    expect(await blob.text()).toBe('png-bytes');
    expect(seen[0]).toMatchObject({ url: 'https://emma.ts.net/api/chat/files/chat0000001/fileAAAAAAA', method: 'GET', ticket: 'view.ticket.sig' });
    serve(() => json({ error: 'not found' }, 404));
    await expect(fetchChatFile('emma.ts.net', 'chat0000001', 'fileAAAAAAA', 'view.ticket.sig')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a message names its files to metro.box', () => {
  test('only the name, type and size of each file are posted, and nothing when there is none', async () => {
    serve(() => json({ chat: { id: 'chat0000001' }, message: MESSAGE, ticket: 't' }));
    const loose = { name: 'plan.pdf', type: 'application/pdf', size: 3, preview: 'blob:x', key: 'pick-1' };
    const started = await startChat('agentEmma01', '', [], [loose]);
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ agent: 'agentEmma01', text: '', files: [{ name: 'plan.pdf', type: 'application/pdf', size: 3 }] });
    expect(started.message.files).toEqual(MESSAGE.files);
    await postChatMessage('chat0000001', 'hi');
    expect(JSON.parse(String(seen.at(-1)?.body))).toEqual({ text: 'hi' });
    await postChatMessage('chat0000001', '', [loose]);
    expect(JSON.parse(String(seen.at(-1)?.body))).toEqual({ text: '', files: [{ name: 'plan.pdf', type: 'application/pdf', size: 3 }] });
  });

  test('a files-only message reads as empty text, not unreadable, and bad files are dropped', () => {
    const read = toChatMessage({ ...MESSAGE, files: [...MESSAGE.files, { id: '../etc', name: 'x', size: 1 }, { id: 'fileBBBBBBB', name: 'big', size: 99_999_999 }, 'nope'] });
    expect(read.text).toBe('');
    expect(read.files).toEqual(MESSAGE.files);
    expect(toChatMessage({ id: 'm', role: 'user', text: null }).text).toBeNull();
    expect(toChatMessage({ id: 'm', role: 'user', text: 'hi' }).files).toEqual([]);
    expect(toChatMessage({ id: 'r', role: 'assistant', files: MESSAGE.files, reply: { parts: [], state: 'done' } }).files).toEqual([]);
  });
});
