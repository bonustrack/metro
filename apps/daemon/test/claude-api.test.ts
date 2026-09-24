import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const PROJECT = '-home-me-proj';
const SESSION = '11111111-2222-4333-8444-555555555555';
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const base_ = { cwd: '/home/me/proj', sessionId: SESSION, version: '2.1.237', gitBranch: 'main' };

let dir = '';
let server: Server;
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-'));
  const project = join(dir, 'projects', PROJECT);
  mkdirSync(join(project, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'projects', 'other'), { recursive: true });
  writeFileSync(
    join(project, `${SESSION}.jsonl`),
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-04T09:00:00.000Z', sessionId: SESSION }) +
      line({ ...base_, type: 'user', uuid: 'u1', timestamp: '2026-09-04T09:00:01.000Z', message: { role: 'user', content: 'Make the sidebar blue' } }) +
      'this line is not json\n' +
      line({ ...base_, type: 'assistant', uuid: 'a1', timestamp: '2026-09-04T09:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }) +
      line({ ...base_, type: 'user', uuid: 'u2', timestamp: '2026-09-04T09:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts\nb.ts', is_error: false }] } }) +
      line({ ...base_, type: 'user', uuid: 'side', isSidechain: true, timestamp: '2026-09-04T09:00:04.000Z', message: { role: 'user', content: 'subagent chatter' } }) +
      line({ ...base_, type: 'user', uuid: 'u3', timestamp: '2026-09-04T09:00:05.000Z', message: { role: 'user', content: '<task-notification>done</task-notification>' } }) +
      line({ ...base_, type: 'assistant', uuid: 'a2', timestamp: '2026-09-04T09:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, it is **blue**.' }] } }) +
      line({ type: 'ai-title', sessionId: SESSION, aiTitle: 'Blue sidebar' }),
  );
  writeFileSync(join(project, 'memory', 'MEMORY.md'), '- [Blue](blue.md) — the sidebar is blue\n');
  writeFileSync(join(project, 'memory', 'blue.md'), '# Blue\n\nThe sidebar is blue.\n');
  writeFileSync(join(project, 'memory', 'notes.txt'), 'not markdown');
  server = createServer((req, res) => {
    const deps = {
      dir: () => dir,
    };
    if (handleClaudeRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const signedPost = async (path: string): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { authorization: await auth(OWNER) } });

const get = async (path: string, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: await auth(subject) } });

const put = async (path: string, body: unknown, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { authorization: await auth(subject), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const putText = async (path: string, body: string, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { authorization: await auth(subject), 'content-type': 'text/plain; charset=utf-8' },
    body,
  });
const json = async <T>(path: string): Promise<T> => (await (await get(path)).json()) as T;

describe('Claude Code sessions and memory, read from the disk the daemon runs on', () => {
  test('projects: one per directory, with the real cwd, session count, last activity and whether memory exists', async () => {
    const { projects } = await json<{ projects: Record<string, unknown>[] }>('/api/claude/projects');
    expect(projects.map((p) => p.id)).toEqual([PROJECT, 'other']);
    expect(projects[0]).toMatchObject({ cwd: '/home/me/proj', sessions: 1, hasMemory: true });
    expect(typeof projects[0]?.lastActiveAt).toBe('string');
    expect(projects[1]).toMatchObject({ cwd: null, sessions: 0, lastActiveAt: null, hasMemory: false });
  });

  test('a session file streams out as plain text and back in, so a box can take another box\'s conversation', async () => {
    const res = await get(`/api/claude/sessions/${SESSION}?project=${PROJECT}&raw=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const raw = await res.text();
    expect(raw).toContain('"aiTitle":"Blue sidebar"');
    expect(raw).toContain('this line is not json');
    const moved = '22222222-2222-4333-8444-555555555555';
    const written = await putText(`/api/claude/sessions/${moved}?project=-root`, raw);
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ id: moved, bytes: Buffer.byteLength(raw) });
    expect(readFileSync(join(dir, 'projects', '-root', `${moved}.jsonl`), 'utf8')).toBe(raw);
    const { sessions } = await json<{ sessions: { id: string }[] }>('/api/claude/sessions?project=-root');
    expect(sessions.map((s) => s.id)).toEqual([moved]);
    expect((await putText(`/api/claude/sessions/${moved}?project=-root`, 'not json lines\n')).status).toBe(400);
    expect(readFileSync(join(dir, 'projects', '-root', `${moved}.jsonl`), 'utf8')).toBe(raw);
    expect((await put(`/api/claude/sessions/${moved}?project=-root`, { text: raw })).status).toBe(415);
    expect((await putText(`/api/claude/sessions/..%2Fescape?project=-root`, raw)).status).toBe(400);
  });

  test('sessions: titled by the ai title, dated by the first line, with branch and version', async () => {
    const { sessions } = await json<{ sessions: Record<string, unknown>[] }>(`/api/claude/sessions?project=${PROJECT}`);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: SESSION, title: 'Blue sidebar', startedAt: '2026-09-04T09:00:00.000Z', gitBranch: 'main', version: '2.1.237' });
  });

  test('the transcript keeps user and assistant turns, drops sidechains, noise and thinking, and paginates', async () => {
    const page = await json<{ entries: { uuid: string; role: string; blocks: Record<string, unknown>[] }[]; total: number; next: number | null }>(
      `/api/claude/sessions/${SESSION}?project=${PROJECT}&limit=2`,
    );
    expect(page.total).toBe(4);
    expect(page.next).toBe(2);
    expect(page.entries.map((e) => e.uuid)).toEqual(['u1', 'a1']);
    expect(page.entries[0]?.blocks).toEqual([{ kind: 'text', text: 'Make the sidebar blue' }]);
    expect(page.entries[1]?.blocks).toEqual([
      { kind: 'thinking' },
      { kind: 'text', text: 'On it.' },
      { kind: 'tool_use', name: 'Bash', input: '{\n "command": "ls"\n}' },
    ]);
    const rest = await json<{ entries: { uuid: string; blocks: Record<string, unknown>[] }[]; next: number | null }>(
      `/api/claude/sessions/${SESSION}?project=${PROJECT}&offset=2`,
    );
    expect(rest.entries.map((e) => e.uuid)).toEqual(['u2', 'a2']);
    expect(rest.entries[0]?.blocks).toEqual([{ kind: 'tool_result', text: 'a.ts\nb.ts', isError: false }]);
    expect(rest.next).toBeNull();
  });

  test('memory: the index and the markdown files, nothing else, each readable by name', async () => {
    const listing = await json<{ files: { name: string }[]; index: string | null }>(`/api/claude/memory?project=${PROJECT}`);
    expect(listing.files.map((f) => f.name)).toEqual(['blue.md']);
    expect(listing.index).toContain('the sidebar is blue');
    const file = await json<{ name: string; content: string }>(`/api/claude/memory/blue.md?project=${PROJECT}`);
    expect(file.content).toContain('# Blue');
    expect((await get(`/api/claude/memory/notes.txt?project=${PROJECT}`)).status).toBe(400);
    expect((await get(`/api/claude/memory/bad%20name.md?project=${PROJECT}`)).status).toBe(400);
    expect((await get(`/api/claude/memory/..%2F..%2Fetc.md?project=${PROJECT}`)).status).toBe(400);
    expect((await get(`/api/claude/memory/gone.md?project=${PROJECT}`)).status).toBe(404);
  });

  test('memory: files in folders are listed by their path and read, written and deleted by it', async () => {
    const root = join(dir, 'projects', PROJECT, 'memory');
    mkdirSync(join(root, 'entities', 'people'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, 'entities', 'people', 'less.md'), '# Less\n');
    writeFileSync(join(root, 'entities', 'MEMORY.md'), '# not the index\n');
    writeFileSync(join(root, '.hidden', 'secret.md'), 'no');
    const names = (await json<{ files: { name: string }[] }>(`/api/claude/memory?project=${PROJECT}`)).files.map((f) => f.name);
    expect(names).toContain('entities/people/less.md');
    expect(names).toContain('entities/MEMORY.md');
    expect(names.some((n) => n.includes('secret'))).toBe(false);
    const nested = `/api/claude/memory/${encodeURIComponent('entities/people/less.md')}?project=${PROJECT}`;
    expect(await json<{ name: string; content: string }>(nested)).toEqual({ name: 'entities/people/less.md', content: '# Less\n' });
    const made = await put(`/api/claude/memory/${encodeURIComponent('timeline/daily/2026-09-24.md')}?project=${PROJECT}`, { text: '# Day\n' });
    expect((await made.json()) as { name: string }).toMatchObject({ name: 'timeline/daily/2026-09-24.md' });
    expect(existsSync(join(root, 'timeline', 'daily', '2026-09-24.md'))).toBe(true);
    for (const bad of ['../x.md', 'a/../x.md', '.hidden/secret.md', 'a//b.md', 'a/b/c/d/e/f/g.md'])
      expect((await get(`/api/claude/memory/${encodeURIComponent(bad)}?project=${PROJECT}`)).status).toBe(400);
    const gone = await fetch(`${base}${nested}`, { method: 'DELETE', headers: { authorization: await auth(OWNER) } });
    expect(await gone.json()).toEqual({ deleted: 'entities/people/less.md' });
    rmSync(join(root, 'entities'), { recursive: true });
    rmSync(join(root, 'timeline'), { recursive: true });
    rmSync(join(root, '.hidden'), { recursive: true });
  });

  test('memory: a file can be written back, and only where the name and size allow', async () => {
    const path = `/api/claude/memory/imported.md?project=${PROJECT}`;
    const made = await put(path, { text: '# Imported\n\nFrom a .metro file.\n' });
    expect(made.status).toBe(200);
    expect((await made.json()) as { name: string }).toMatchObject({ name: 'imported.md' });
    expect((await json<{ content: string }>(path)).content).toContain('From a .metro file');

    const again = await put(path, { text: '# Imported\n\nSecond write wins.\n' });
    expect(again.status).toBe(200);
    expect((await json<{ content: string }>(path)).content).toContain('Second write wins');
    expect((await json<{ files: { name: string }[] }>(`/api/claude/memory?project=${PROJECT}`)).files.map((f) => f.name)).toEqual([
      'imported.md',
      'blue.md',
    ]);

    const old = await put(`/api/claude/memory/older.md?project=${PROJECT}`, { text: '# Older\n', modifiedAt: '2026-01-02T03:04:05.000Z' });
    expect((await old.json()) as { modifiedAt: string }).toMatchObject({ modifiedAt: '2026-01-02T03:04:05.000Z' });
    expect((await json<{ files: { name: string }[] }>(`/api/claude/memory?project=${PROJECT}`)).files.map((f) => f.name)).toEqual([
      'imported.md',
      'blue.md',
      'older.md',
    ]);
    expect((await put(`/api/claude/memory/older.md?project=${PROJECT}`, { text: '# Older\n', modifiedAt: 'yesterday-ish' })).status).toBe(200);

    expect((await put(path, { text: '   ' })).status).toBe(400);
    expect((await put(path, {})).status).toBe(400);
    expect((await put(path, { text: 'x'.repeat(256 * 1024 + 1) })).status).toBe(400);
    expect((await put(`/api/claude/memory/notes.txt?project=${PROJECT}`, { text: 'no' })).status).toBe(400);
    expect((await put(`/api/claude/memory/..%2F..%2Fescape.md?project=${PROJECT}`, { text: 'no' })).status).toBe(400);
  });

  test('a memory file can be deleted, once, and only by name', async () => {
    const drop = async (name: string, subject = OWNER): Promise<Response> =>
      fetch(`${base}/api/claude/memory/${name}?project=${PROJECT}`, {
        method: 'DELETE',
        headers: { authorization: await auth(subject) },
      });
    await put(`/api/claude/memory/spare.md?project=${PROJECT}`, { text: '# Spare\n' });
    const res = await drop('spare.md');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 'spare.md' });
    expect(existsSync(join(dir, 'projects', PROJECT, 'memory', 'spare.md'))).toBe(false);
    expect((await drop('spare.md')).status).toBe(404);
    expect((await drop('notes.txt')).status).toBe(400);
    expect((await drop('..%2F..%2Fetc.md')).status).toBe(400);
    expect(existsSync(join(dir, 'projects', PROJECT, 'memory', 'blue.md'))).toBe(true);
  });

  test('a bad project or session id never touches the disk beyond the projects dir', async () => {
    expect((await get('/api/claude/sessions?project=../../etc')).status).toBe(400);
    expect((await get('/api/claude/sessions?project=nope')).status).toBe(404);
    expect((await get(`/api/claude/sessions/x?project=${PROJECT}`)).status).toBe(400);
    expect((await get(`/api/claude/sessions/..%2F..%2Fetc?project=${PROJECT}`)).status).toBe(400);
    expect((await get(`/api/claude/sessions/00000000-0000-4000-8000-000000000000?project=${PROJECT}`)).status).toBe(404);
    expect((await get('/api/claude/sessions')).status).toBe(400);
    expect((await get('/api/claude/nope')).status).toBe(404);
  });

  test('a session can be deleted, with its sidecar directory, once', async () => {
    mkdirSync(join(dir, 'projects', PROJECT, SESSION), { recursive: true });
    writeFileSync(join(dir, 'projects', PROJECT, SESSION, 'tool-results.json'), '{}');
    const del = async (subject = OWNER): Promise<Response> =>
      fetch(`${base}/api/claude/sessions/${SESSION}?project=${PROJECT}`, {
        method: 'DELETE',
        headers: { authorization: await auth(subject) },
      });
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: SESSION });
    expect(existsSync(join(dir, 'projects', PROJECT, `${SESSION}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, 'projects', PROJECT, SESSION))).toBe(false);
    expect((await del()).status).toBe(404);
    expect((await fetch(`${base}/api/claude/projects`, { method: 'DELETE', headers: { authorization: await auth(OWNER) } })).status).toBe(405);
  });

  test('no session gets 401, and only GET is served', async () => {
    expect((await fetch(`${base}/api/claude/projects`)).status).toBe(401);
    expect((await fetch(`${base}/api/claude/projects`, { method: 'POST' })).status).toBe(401);
    expect((await signedPost('/api/claude/projects')).status).toBe(405);
    expect((await fetch(`${base}/api/claude/projects`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
