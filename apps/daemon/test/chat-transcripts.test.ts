import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { ChatSessions } from '../src/chat/sessions.js';
import { auth, TEST_OWNER } from './identity-helper.ts';

const PROJECT = '-home-agent';
const MAIN = '11111111-2222-4333-8444-555555555555';
const CHAT = '99999999-2222-4333-8444-555555555555';
const SECRET = 'a private chat line';

let dir = '';
let agents = '';
let server: Server;
let base = '';
let sessions: ChatSessions;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-'));
  agents = mkdtempSync(join(tmpdir(), 'metro-agents-'));
  mkdirSync(join(dir, 'projects', PROJECT), { recursive: true });
  for (const id of [MAIN, CHAT]) writeFileSync(join(dir, 'projects', PROJECT, `${id}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: id === CHAT ? SECRET : `hello from ${id}` } })}\n`);
  utimesSync(join(dir, 'projects', PROJECT, `${MAIN}.jsonl`), new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'));
  sessions = new ChatSessions(agents);
  sessions.keep('chat0000001', CHAT);
  server = createServer((req, res) => {
    if (!handleClaudeRequest(req, res, { dir: () => dir, hidden: (id) => sessions.hides(id) })) res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(agents, { recursive: true, force: true });
});

const call = async (path: string, method = 'GET'): Promise<Response> => fetch(`${base}${path}`, { method, headers: { authorization: await auth(TEST_OWNER, 'member') } });

describe('a metro.box chat stays out of the agent’s Sessions page', () => {
  test('the list leaves it out, and reading, downloading or deleting it is a 404', async () => {
    const listed = (await (await call(`/api/claude/sessions?project=${PROJECT}`)).json()) as { sessions: { id: string }[] };
    expect(listed.sessions.map((s) => s.id)).toEqual([MAIN]);
    expect((await call(`/api/claude/sessions/${CHAT}?project=${PROJECT}`)).status).toBe(404);
    expect((await call(`/api/claude/sessions/${CHAT}?project=${PROJECT}&raw=1`)).status).toBe(404);
    expect((await call(`/api/claude/sessions/${CHAT}?project=${PROJECT}`, 'DELETE')).status).toBe(404);
    expect((await call(`/api/claude/sessions/${MAIN}?project=${PROJECT}`)).status).toBe(200);
  });

  test('the project list neither counts it nor dates itself by it', async () => {
    const listed = (await (await call('/api/claude/projects')).json()) as { projects: { id: string; sessions: number; lastActiveAt: string | null }[] };
    expect(listed.projects.find((p) => p.id === PROJECT)).toMatchObject({ sessions: 1, lastActiveAt: '2026-11-01T10:00:00.000Z' });
    for (const path of ['/api/claude//projects', '/api/claude/projects/']) expect(await (await call(path)).json()).toEqual(listed);
  });

  test('every spelling of the same path is refused or filtered the same way', async () => {
    for (const path of [`/api/claude/sessions/?project=${PROJECT}`, `/api/claude//sessions?project=${PROJECT}`, `/api/claude/sessions//?project=${PROJECT}`]) {
      const res = await call(path);
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(CHAT);
    }
    for (const path of [`/api/claude//sessions/${CHAT}?project=${PROJECT}`, `/api/claude/sessions//${CHAT}?project=${PROJECT}`, `/api/claude/sessions//${CHAT}?project=${PROJECT}&raw=1`, `/api/claude//sessions//${CHAT}/?project=${PROJECT}&raw=1`, `/api/claude/sessions/${CHAT.toUpperCase()}?project=${PROJECT}`, `/api/claude/sessions/${CHAT}?project=${PROJECT}&tool=t1`]) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    }
    expect((await call(`/api/claude//sessions//${CHAT}?project=${PROJECT}`, 'DELETE')).status).toBe(404);
    expect((await call(`/api/claude/sessions/${CHAT}?project=${PROJECT}`, 'PUT')).status).toBe(404);
    expect(readFileSync(join(dir, 'projects', PROJECT, `${CHAT}.jsonl`), 'utf8')).toContain(SECRET);
  });
});

describe('the chat sessions file', () => {
  test('a chat whose resume entry is dropped for room stays hidden', () => {
    const at = mkdtempSync(join(tmpdir(), 'metro-agents-'));
    try {
      const kept = new ChatSessions(at);
      kept.keep('chat0000001', CHAT);
      for (let i = 0; i < 2_001; i += 1) kept.keep(`c${String(i).padStart(10, '0')}`, `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const reread = new ChatSessions(at);
      expect(reread.of('chat0000001')).toBeNull();
      expect(reread.hides(CHAT)).toBe(true);
      expect(reread.hides(MAIN)).toBe(false);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  test('an unreadable file hides every transcript and is never written over', () => {
    const at = mkdtempSync(join(tmpdir(), 'metro-agents-'));
    try {
      const path = join(at, 'chat-sessions.json');
      for (const text of ['{not json', JSON.stringify({ version: 2, sessions: {} }), JSON.stringify({ version: 1, sessions: {}, hidden: 'x' })]) {
        writeFileSync(path, text);
        const kept = new ChatSessions(at);
        expect(kept.hides(MAIN)).toBe(true);
        kept.keep('chat0000002', CHAT);
        expect(kept.of('chat0000002')).toBe(CHAT);
        expect(readFileSync(path, 'utf8')).toBe(text);
      }
      rmSync(path);
      expect(new ChatSessions(at).hides(MAIN)).toBe(false);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  test('a file from before the hidden list still hides the chats it names', () => {
    const at = mkdtempSync(join(tmpdir(), 'metro-agents-'));
    try {
      writeFileSync(join(at, 'chat-sessions.json'), JSON.stringify({ version: 1, sessions: { chat0000001: CHAT, bad: '../x', chat0000003: '../../etc' } }));
      const kept = new ChatSessions(at);
      expect(kept.hides(CHAT)).toBe(true);
      expect(kept.of('chat0000003')).toBeNull();
      expect(kept.hides(MAIN)).toBe(false);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});
