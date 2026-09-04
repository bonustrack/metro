import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/daemon/claude-api.js';
import { signSession } from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SECRET = 'claude-test-secret';
const PROJECT = '-home-me-proj';
const SESSION = '11111111-2222-4333-8444-555555555555';
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const base_ = { cwd: '/home/me/proj', sessionId: SESSION, version: '2.1.237', gitBranch: 'main' };

let dir = '';
let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
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
      authorize: (subject: string) => {
        if (subject !== OWNER) throw new ApiError('no such project', 404);
      },
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
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

const get = (path: string, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${signSession({ subject, agentIds: [] }, SECRET)}` } });
const json = async <T>(path: string): Promise<T> => (await (await get(path)).json()) as T;

describe('Claude Code sessions and memory, read from the disk the daemon runs on', () => {
  test('projects: one per directory, with the real cwd, session count, last activity and whether memory exists', async () => {
    const { projects } = await json<{ projects: Record<string, unknown>[] }>('/api/claude/projects');
    expect(projects.map((p) => p.id)).toEqual([PROJECT, 'other']);
    expect(projects[0]).toMatchObject({ cwd: '/home/me/proj', sessions: 1, hasMemory: true });
    expect(typeof projects[0]?.lastActiveAt).toBe('string');
    expect(projects[1]).toMatchObject({ cwd: null, sessions: 0, lastActiveAt: null, hasMemory: false });
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
    const del = (subject = OWNER): Promise<Response> =>
      fetch(`${base}/api/claude/sessions/${SESSION}?project=${PROJECT}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${signSession({ subject, agentIds: [] }, SECRET)}` },
      });
    expect((await del(STRANGER)).status).toBe(404);
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: SESSION });
    expect(existsSync(join(dir, 'projects', PROJECT, `${SESSION}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, 'projects', PROJECT, SESSION))).toBe(false);
    expect((await del()).status).toBe(404);
    expect((await fetch(`${base}/api/claude/projects`, { method: 'DELETE', headers: { authorization: `Bearer ${signSession({ subject: OWNER, agentIds: [] }, SECRET)}` } })).status).toBe(405);
  });

  test('a stranger gets 404s, no session gets 401, and only GET is served', async () => {
    expect((await get('/api/claude/projects', STRANGER)).status).toBe(404);
    expect((await fetch(`${base}/api/claude/projects`)).status).toBe(401);
    expect((await fetch(`${base}/api/claude/projects`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/claude/projects`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
