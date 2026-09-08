import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/daemon/claude-api.js';
import { ApiError } from '../src/daemon/api-error.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SESSION = '11111111-2222-4333-8444-555555555555';

let dir = '';
let workspace = '';
let bare = '';
let project = '';
let server: Server;
let base = '';

const transcript = (cwd: string): string =>
  `${JSON.stringify({ type: 'user', uuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-09-08T09:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-settings-'));
  workspace = mkdtempSync(join(tmpdir(), 'metro-workspace-'));
  bare = mkdtempSync(join(tmpdir(), 'metro-bare-'));
  project = workspace.replace(/[/.]/g, '-');
  mkdirSync(join(dir, 'projects', project), { recursive: true });
  mkdirSync(join(dir, 'projects', bare.replace(/[/.]/g, '-')), { recursive: true });
  writeFileSync(join(dir, 'projects', project, `${SESSION}.jsonl`), transcript(workspace));
  writeFileSync(join(dir, 'projects', bare.replace(/[/.]/g, '-'), `${SESSION}.jsonl`), transcript(bare));
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
  for (const path of [dir, workspace, bare]) rmSync(path, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(join(dir, 'settings.json'), '{\n  "model": "opus"\n}\n');
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  writeFileSync(join(workspace, '.claude', 'settings.json'), '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}');
  chmodSync(join(workspace, '.claude', 'settings.json'), 0o640);
  rmSync(join(workspace, '.claude', 'settings.local.json'), { force: true });
  rmSync(join(bare, '.claude'), { recursive: true, force: true });
});

interface SettingsFile {
  id: string;
  scope: string;
  label: string;
  path: string;
  exists: boolean;
  editable: boolean;
  text: string;
  modifiedAt: string | null;
}

const get = async (path: string, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: await auth('GET', path, subject) } });

const put = async (path: string, body: unknown, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { authorization: await auth('PUT', path, subject), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const listing = async (): Promise<SettingsFile[]> =>
  ((await (await get('/api/claude/settings')).json()) as { files: SettingsFile[] }).files;

describe('Claude Code settings, read and written on the machine the daemon runs on', () => {
  test('the machine file comes first, then every project file that exists, and a project with none is not listed', async () => {
    const files = await listing();
    expect(files.map((f) => f.id)).toEqual(['user', project]);
    expect(files[0]).toMatchObject({ scope: 'user', label: 'This machine', path: join(dir, 'settings.json'), exists: true, editable: true });
    expect(files[0]?.text).toContain('"model": "opus"');
    expect(typeof files[0]?.modifiedAt).toBe('string');
    expect(files[1]).toMatchObject({ scope: 'project', label: workspace, path: join(workspace, '.claude', 'settings.json'), exists: true });
    writeFileSync(join(workspace, '.claude', 'settings.local.json'), '{"permissions":{}}');
    expect((await listing()).map((f) => f.id)).toEqual(['user', project, `${project}.local`]);
  });

  test('a file that does not exist yet is offered empty, and saving it creates it', async () => {
    rmSync(join(dir, 'settings.json'));
    const before = (await listing())[0];
    expect(before).toMatchObject({ id: 'user', exists: false, text: '', modifiedAt: null });
    const saved = await put('/api/claude/settings/user', { text: '{"model":"sonnet"}', seenAt: null });
    expect(saved.status).toBe(200);
    expect((await saved.json()) as SettingsFile).toMatchObject({ id: 'user', exists: true, text: '{"model":"sonnet"}' });
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}');
  });

  test('saving a project file rewrites it in place and keeps the mode it had', async () => {
    const path = join(workspace, '.claude', 'settings.json');
    const seenAt = (await listing())[1]?.modifiedAt ?? null;
    const res = await put(`/api/claude/settings/${project}`, { text: '{\n  "env": {}\n}\n', seenAt });
    expect(res.status).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe('{\n  "env": {}\n}\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(existsSync(`${path}.metro-${String(process.pid)}`)).toBe(false);
  });

  test('anything that is not a JSON object is refused, and the file on disk is untouched', async () => {
    const path = join(dir, 'settings.json');
    const kept = readFileSync(path, 'utf8');
    for (const text of ['{', '[1,2]', '"a string"', '42', '']) {
      const res = await put('/api/claude/settings/user', { text });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
    expect((await put('/api/claude/settings/user', {})).status).toBe(400);
    expect(readFileSync(path, 'utf8')).toBe(kept);
  });

  test('a file that changed on disk since it was read refuses the save', async () => {
    const seenAt = (await listing())[0]?.modifiedAt ?? null;
    writeFileSync(join(dir, 'settings.json'), '{"model":"someone else"}');
    const stale = await put('/api/claude/settings/user', { text: '{"model":"mine"}', seenAt });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"model":"someone else"}');
    const fresh = (await listing())[0]?.modifiedAt ?? null;
    expect((await put('/api/claude/settings/user', { text: '{"model":"mine"}', seenAt: fresh })).status).toBe(200);
  });

  test('only a listed file can be written, so a made-up id or a path is a 404 and nothing is created', async () => {
    for (const id of ['nope', '..%2F..%2Fetc%2Fpasswd', encodeURIComponent(join(workspace, '.claude', 'settings.json')), `${project}.other`]) {
      expect((await put(`/api/claude/settings/${id}`, { text: '{}' })).status).toBe(404);
    }
    expect(existsSync(join(bare, '.claude'))).toBe(false);
    expect((await put('/api/claude/settings/', { text: '{}' })).status).toBe(405);
    expect((await get('/api/claude/settings/user')).status).toBe(404);
  });

  test('a stranger reads and writes nothing', async () => {
    expect((await get('/api/claude/settings', STRANGER)).status).toBe(404);
    expect((await put('/api/claude/settings/user', { text: '{}' }, STRANGER)).status).toBe(404);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toContain('opus');
  });
});
