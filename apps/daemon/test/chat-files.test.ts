import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatFile } from '@metro-labs/core/chat';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { signChatTicket, textDigest, type ChatTicketClaims } from '@metro-labs/http/chat-ticket';
import { handleChatRequest, type ChatApiDeps } from '../src/chat/api.ts';
import { ChatFiles, extOf } from '../src/chat/files.ts';
import { handleChatFileRequest } from '../src/chat/files-api.ts';
import { ChatGate } from '../src/chat/tickets.ts';
import { only, rig, tick } from './chat-rig.ts';

const OWNER = 'org_01TESTOWNER000000';
const AGENT = 'agent000001';
const ALICE = 'user_01ALICE';
const CHAT = 'chat0000001';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = { kid: 'key-1', privateKey: pair.privateKey };
const keys = { keyFor: (kid: string) => Promise.resolve(kid === 'key-1' ? pair.publicKey : null) };

const PNG: ChatFile = { id: 'file0000001', name: 'chart.png', type: 'image/png', size: 5 };
const PDF: ChatFile = { id: 'file0000002', name: 'Q3 (final)\'s "plan"; filename=x.html.pdf', type: 'application/pdf', size: 3 };

const ticketOf = (over: Partial<ChatTicketClaims> = {}): string =>
  signChatTicket(signer, { organization: OWNER, agent: AGENT, chat: CHAT, user: ALICE, name: 'Alice', email: 'alice@example.com', act: 'send', message: 'msg00000001', digest: textDigest(''), files: [PNG, PDF], group: false, ...over });

const viewOf = (chat = CHAT): string => ticketOf({ act: 'view', message: null, digest: null, files: [], chat });

const home = mkdtempSync(join(tmpdir(), 'metro-chat-home-'));
const root = join(home, 'chat-files');
const files = new ChatFiles(() => root);
const made = rig({ share: (input) => files.share(input) });
let server: Server;
let base = '';

beforeAll(async () => {
  setBearerSessions((req) => {
    const who = req.headers.authorization;
    if (who === 'Bearer alice') return Promise.resolve({ subject: OWNER, userId: ALICE, sessionId: 's', role: 'member' });
    return Promise.resolve(who === 'Bearer bob' ? { subject: OWNER, userId: 'user_01BOB', sessionId: 's', role: 'member' } : null);
  });
  const deps: ChatApiDeps = { gate: new ChatGate({ keys, owner: () => OWNER, server: () => AGENT, now: () => Date.now() }), turns: made.turns, files, waitMs: 200 };
  server = createServer((req, res) => {
    if (!handleChatRequest(req, res, deps) && !handleChatFileRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
});

afterAll(() => {
  server.close();
  setBearerSessions(null);
  rmSync(made.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const headers = (who: string | null, ticket: string | null): Record<string, string> => ({
  ...(who === null ? {} : { authorization: `Bearer ${who}` }),
  ...(ticket === null ? {} : { 'x-metro-chat-ticket': ticket }),
});

const put = (path: string, body: BodyInit, ticket: string | null = ticketOf(), who: string | null = 'alice'): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', headers: { ...headers(who, ticket), 'content-type': 'application/octet-stream' }, body, duplex: 'half' } as RequestInit);

const get = (path: string, ticket: string | null = viewOf(), who: string | null = 'alice'): Promise<Response> => fetch(`${base}${path}`, { headers: headers(who, ticket) });

const startTurn = (body: unknown): Promise<Response> =>
  fetch(`${base}/api/chat/turns`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer alice' }, body: JSON.stringify(body) });

const chunks = (...parts: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller): void {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

const stored = (id: string, ext = ''): string => join(root, CHAT, ext === '' ? id : `${id}.${ext}`);
const leftovers = (): string[] => (existsSync(join(root, CHAT)) ? readdirSync(join(root, CHAT)).filter((name) => name.includes('.up-') || name.includes('.metro-')) : []);

describe('uploading a file for the agent', () => {
  test('only a signed-in person with a send ticket for that message and that file may upload, and anything else is a plain 404', async () => {
    expect((await put('/api/chat/files/msg00000001/file0000001', 'hello', ticketOf(), null)).status).toBe(401);
    expect((await put('/api/chat/files/msg00000001/file0000001', 'hello', null)).status).toBe(403);
    expect((await put('/api/chat/files/msg00000001/file0000001', 'hello', ticketOf(), 'bob')).status).toBe(403);
    expect((await put('/api/chat/files/msg00000001/file0000001', 'hello', viewOf())).status).toBe(404);
    expect((await put('/api/chat/files/msg00000002/file0000001', 'hello', ticketOf())).status).toBe(404);
    expect((await put('/api/chat/files/msg00000001/file0000009', 'hello', ticketOf())).status).toBe(404);
    for (const path of ['/api/chat/files/..%2F..%2F..%2Fetc/file0000001', '/api/chat/files/msg00000001/..', '/api/chat/files/msg00000001/file0000001%00', '/api/chat/files/msg00000001/file00000011', '/api/chat/files/msg00000001']) {
      expect((await put(path, 'hello')).status).toBe(404);
    }
    expect(existsSync(root)).toBe(false);
  });

  test('takes exactly the signed size: more bytes or fewer is a 400 and leaves nothing behind', async () => {
    expect((await put('/api/chat/files/msg00000001/file0000001', 'hello!')).status).toBe(400);
    expect((await put('/api/chat/files/msg00000001/file0000001', 'hell')).status).toBe(400);
    expect((await put('/api/chat/files/msg00000001/file0000001', chunks('hel', 'lo', '!!'))).status).toBe(400);
    expect((await put('/api/chat/files/msg00000001/file0000001', chunks('he', 'll'))).status).toBe(400);
    expect(existsSync(stored(PNG.id, 'png'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test('stores the bytes as the file, with what metro.box said about it beside it, and a second upload replaces it', async () => {
    for (const [path, method] of [['/api/chat/files/msg00000001/file0000001', 'PUT'], [`/api/chat/files/${CHAT}/file0000001`, 'GET']]) {
      const preflight = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin: 'https://metro.box', 'access-control-request-method': method, 'access-control-request-headers': 'authorization, content-type, x-metro-chat-ticket' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://metro.box');
      expect(preflight.headers.get('access-control-allow-methods')?.split(', ')).toEqual(expect.arrayContaining(['PUT', 'GET']));
      expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase().split(', ')).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-metro-chat-ticket']));
    }
    expect(await (await put('/api/chat/files/msg00000001/file0000001', chunks('hel', 'lo'))).json()).toEqual({ file: PNG.id, size: 5 });
    expect((await put('/api/chat/files/msg00000001/file0000001', 'HELLO')).status).toBe(200);
    expect(readFileSync(stored(PNG.id, 'png'), 'utf8')).toBe('HELLO');
    expect(statSync(stored(PNG.id, 'png')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(stored(PNG.id, 'meta.json'), 'utf8'))).toEqual({ name: 'chart.png', type: 'image/png', size: 5, chat: CHAT, message: 'msg00000001', at: expect.any(Number) });
    expect(leftovers()).toEqual([]);
  });
});

describe('starting a turn with files', () => {
  test('starts with the files that arrived at their exact size and tells the agent which did not, so a chat never gets stuck', async () => {
    writeFileSync(stored(PDF.id, 'pdf'), 'ab');
    writeFileSync(stored(PDF.id, 'meta.json'), JSON.stringify({ name: PDF.name, type: PDF.type, size: 2, chat: CHAT, message: 'msg00000001', at: 1 }));
    expect((await startTurn({ ticket: ticketOf({ files: [], digest: textDigest('') }), text: '' })).status).toBe(400);
    const started = await startTurn({ ticket: ticketOf(), text: '' });
    expect(await started.json()).toEqual({ turn: 'msg00000001' });
    await tick();
    const line = only(made.children).sent[0];
    expect(line).toMatchObject({ t: 'turn', prompt: '', files: [{ path: stored(PNG.id, 'png'), name: 'chart.png', type: 'image/png', size: 5 }], missing: [{ name: PDF.name, type: 'application/pdf', size: 3 }] });
    expect((await put('/api/chat/files/msg00000001/file0000001', 'xxxxx')).status).toBe(409);
    expect(readFileSync(stored(PNG.id, 'png'), 'utf8')).toBe('HELLO');
    const nothing = ticketOf({ chat: 'chat0000005', message: 'msg00000005', files: [{ id: 'file0000005', name: 'gone.txt', type: 'text/plain', size: 4 }] });
    expect(await (await startTurn({ ticket: nothing, text: '' })).json()).toEqual({ turn: 'msg00000005' });
    await tick();
    expect(only(made.children, 1).sent[0]).toEqual({ t: 'turn', prompt: '', from: { name: 'Alice', email: 'alice@example.com' }, resume: null, missing: [{ name: 'gone.txt', type: 'text/plain', size: 4 }] });
    only(made.children, 1).exit(0);
  });

  test('a stored file keeps the extension of its name, and its sidecar can never be taken for a file', () => {
    expect(['a.PDF', 'a.tar.gz', 'a.TAR-GZ', 'noext', 'a.abcdefghijk', 'a.', 'photo.jpeg'].map(extOf)).toEqual(['pdf', 'gz', '', '', '', '', 'jpeg']);
  });
});

describe('the files the agent shares back', () => {
  test('are copied as the agent into the chat, take their place in the reply and are saved with it, while one it cannot copy keeps its place empty', async () => {
    const child = only(made.children);
    const outside = mkdtempSync(join(tmpdir(), 'metro-chat-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(home, 'report.csv'), 'a,b\n1,2\n');
    symlinkSync(join(outside, 'secret.txt'), join(home, 'leak.txt'));
    child.say({ t: 'part', n: 0, part: { type: 'text', text: 'Here' } });
    child.say({ t: 'share', n: 1, path: join(home, 'report.csv'), name: 'report.csv', type: 'text/csv' });
    child.say({ t: 'share', n: 2, path: join(home, 'leak.txt'), name: 'leak.txt', type: 'text/plain' });
    child.say({ t: 'share', n: 3, path: home, name: 'home', type: 'text/plain' });
    child.say({ t: 'share', n: 4, path: `${home}/../x`, name: 'x', type: 'text/plain' });
    child.say({ t: 'part', n: 5, part: { type: 'text', text: 'Done' } });
    child.say({ t: 'done', state: 'done', error: null });
    child.exit(0);
    await tick(200);
    const reply = made.posted.find((p) => p.chat === CHAT)?.reply;
    expect(reply?.parts.map((part) => part.type)).toEqual(['text', 'file', 'text', 'text', 'text', 'text']);
    expect(reply?.parts.slice(2, 5)).toEqual([{ type: 'text', text: '' }, { type: 'text', text: '' }, { type: 'text', text: '' }]);
    const part = reply?.parts[1];
    const file = part?.type === 'file' ? part.file : null;
    expect(file).toMatchObject({ name: 'report.csv', type: 'text/csv', size: 8 });
    expect(readFileSync(stored(file?.id ?? '', 'csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(readdirSync(join(root, CHAT)).filter((name) => !name.startsWith('file') && !name.startsWith(file?.id ?? '-'))).toEqual([]);
    const served = await get(`/api/chat/files/${CHAT}/${file?.id ?? ''}`);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(await served.text()).toBe('a,b\n1,2\n');
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('reading a chat file', () => {
  test('serves an image inline and anything else as a download, never sniffed, to anyone with a ticket of that chat', async () => {
    const image = await get(`/api/chat/files/${CHAT}/${PNG.id}`);
    expect(image.status).toBe(200);
    expect(Object.fromEntries(['content-type', 'content-disposition', 'content-length', 'x-content-type-options', 'cache-control'].map((h) => [h, image.headers.get(h)]))).toEqual({
      'content-type': 'image/png',
      'content-disposition': 'inline',
      'content-length': '5',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    });
    expect(await image.text()).toBe('HELLO');
    const pdf = await get(`/api/chat/files/${CHAT}/${PDF.id}`, ticketOf());
    expect(pdf.headers.get('content-type')).toBe('application/octet-stream');
    expect(pdf.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Q3%20%28final%29%27s%20%22plan%22%3B%20filename%3Dx.html.pdf");
    expect(await pdf.text()).toBe('ab');
  });

  test('an uploaded JSON file is stored as <id>.json and served as itself, never read as a sidecar', async () => {
    const data: ChatFile = { id: 'file0000003', name: 'data.json', type: 'application/json', size: 0 };
    const body = JSON.stringify({ name: 'evil.png', type: 'image/png', size: 5, chat: 'chat0000004', message: 'msg00000003', at: 1 });
    const ticket = ticketOf({ chat: 'chat0000004', message: 'msg00000003', files: [{ ...data, size: body.length }] });
    expect((await put('/api/chat/files/msg00000003/file0000003', body, ticket)).status).toBe(200);
    expect(readdirSync(join(root, 'chat0000004')).sort()).toEqual(['file0000003.json', 'file0000003.meta.json']);
    const served = await get('/api/chat/files/chat0000004/file0000003', viewOf('chat0000004'));
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''data.json");
    expect(await served.text()).toBe(body);
    writeFileSync(join(root, 'chat0000004', 'file0000004'), 'x');
    writeFileSync(join(root, 'chat0000004', 'file0000004.json'), JSON.stringify({ name: 'x', type: 'image/png', size: 1, chat: 'chat0000004', message: 'msg00000003', at: 1 }));
    expect((await get('/api/chat/files/chat0000004/file0000004', viewOf('chat0000004'))).status).toBe(404);
  });

  test('a ticket of another chat, a missing file, a link and a bad address are all a 404, and no sign-in is a 401', async () => {
    expect((await get(`/api/chat/files/${CHAT}/${PNG.id}`, viewOf('chat0000002'))).status).toBe(404);
    expect((await get(`/api/chat/files/chat0000002/${PNG.id}`, viewOf('chat0000002'))).status).toBe(404);
    expect((await get(`/api/chat/files/${CHAT}/file0000009`)).status).toBe(404);
    expect((await get(`/api/chat/files/${CHAT}/..%2F..%2Fx`)).status).toBe(404);
    expect((await get(`/api/chat/files/${CHAT}/${PNG.id}`, viewOf(), null)).status).toBe(401);
    expect((await get(`/api/chat/files/${CHAT}/${PNG.id}`, null)).status).toBe(403);
    const outside = join(home, 'outside.png');
    writeFileSync(outside, 'NOPE!');
    mkdirSync(join(root, 'chat0000003'));
    symlinkSync(outside, join(root, 'chat0000003', `${PNG.id}.png`));
    writeFileSync(join(root, 'chat0000003', `${PNG.id}.meta.json`), JSON.stringify({ name: 'x.png', type: 'image/png', size: 5, chat: 'chat0000003', message: 'msg00000001', at: 1 }));
    expect((await get(`/api/chat/files/chat0000003/${PNG.id}`, viewOf('chat0000003'))).status).toBe(404);
  });
});

describe('cleaning up chat files', () => {
  test('removes files older than the limit and empty chat folders, as the agent, and never follows a link out', async () => {
    const sweep = mkdtempSync(join(tmpdir(), 'metro-chat-sweep-'));
    const dir = join(sweep, 'chat-files');
    const outside = join(sweep, 'outside');
    mkdirSync(join(dir, 'chatold0001'), { recursive: true });
    mkdirSync(join(dir, 'chatnew0001'), { recursive: true });
    mkdirSync(join(dir, 'chatempty01'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(dir, 'chatold0001', 'file0000001'), 'old');
    writeFileSync(join(dir, 'chatold0001', 'file0000001.json'), '{}');
    writeFileSync(join(dir, 'chatnew0001', 'file0000002'), 'new');
    writeFileSync(join(outside, 'keep'), 'keep');
    symlinkSync(outside, join(dir, 'chatlink001'));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    for (const path of [join(dir, 'chatold0001', 'file0000001'), join(dir, 'chatold0001', 'file0000001.json'), join(outside, 'keep')]) utimesSync(path, old, old);
    const sweeper = new ChatFiles(() => dir);
    expect(await sweeper.sweep(7 * 24 * 60 * 60_000, 1024 ** 3)).toBe(2);
    utimesSync(join(dir, 'chatold0001'), old, old);
    utimesSync(join(dir, 'chatempty01'), old, old);
    await sweeper.sweep(7 * 24 * 60 * 60_000, 1024 ** 3);
    expect(readdirSync(dir).sort()).toEqual(['chatlink001', 'chatnew0001']);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
    expect(await new ChatFiles(() => join(sweep, 'none')).sweep(1, 1)).toBe(0);
    expect(await new ChatFiles(() => null).sweep(1, 1)).toBe(0);
    rmSync(sweep, { recursive: true, force: true });
  });

  test('keeps the folder under its size budget, oldest files first with their sidecars, and never follows a link', async () => {
    const sweep = mkdtempSync(join(tmpdir(), 'metro-chat-cap-'));
    const dir = join(sweep, 'chat-files');
    const outside = join(sweep, 'outside');
    mkdirSync(join(dir, 'chat0000001'), { recursive: true });
    mkdirSync(join(dir, 'chat0000002'), { recursive: true });
    mkdirSync(outside);
    const put = (chat: string, id: string, bytes: number, hoursAgo: number): void => {
      const at = new Date(Date.now() - hoursAgo * 60 * 60_000);
      for (const [name, size] of [[`${id}.bin`, bytes], [`${id}.meta.json`, 10]] as const) {
        writeFileSync(join(dir, chat, name), 'x'.repeat(size));
        utimesSync(join(dir, chat, name), at, at);
      }
    };
    put('chat0000001', 'file0000001', 400, 30);
    put('chat0000002', 'file0000002', 400, 20);
    put('chat0000001', 'file0000003', 400, 10);
    writeFileSync(join(outside, 'big.bin'), 'x'.repeat(5000));
    symlinkSync(outside, join(dir, 'chatlink001'));
    symlinkSync(join(outside, 'big.bin'), join(dir, 'chat0000002', 'file0000009.bin'));
    expect(await new ChatFiles(() => dir).sweep(7 * 24 * 60 * 60_000, 500)).toBe(4);
    expect(readdirSync(join(dir, 'chat0000001'))).toEqual(['file0000003.bin', 'file0000003.meta.json']);
    expect(readdirSync(join(dir, 'chat0000002')).sort()).toEqual(['file0000009.bin']);
    expect(readFileSync(join(outside, 'big.bin'), 'utf8')).toHaveLength(5000);
    expect(await new ChatFiles(() => dir).sweep(7 * 24 * 60 * 60_000, 500)).toBe(0);
    rmSync(sweep, { recursive: true, force: true });
  });
});
