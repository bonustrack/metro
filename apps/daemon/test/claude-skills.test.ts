import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const SESSION = '11111111-2222-4333-8444-555555555555';

let dir = '';
let workspace = '';
let projectId = '';
let server: Server;
let base = '';

interface Skill {
  id: string;
  name: string;
  title: string;
  description: string;
  updatedAt: string;
  editable: boolean;
}

const skill = (name: string, description: string): string =>
  ['---', `name: ${name}`, `description: ${description}`, '---', '', 'Do the thing.', ''].join('\n');

const call = async (method: string, path: string, body?: unknown, who = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: await auth(method, path.split('?')[0] ?? path, who),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const list = async (): Promise<{ skills: Skill[] }> => (await (await call('GET', '/api/claude/skills')).json()) as { skills: Skill[] };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-skills-'));
  workspace = mkdtempSync(join(tmpdir(), 'metro-skill-workspace-'));
  projectId = workspace.replace(/[/.]/g, '-');
  mkdirSync(join(dir, 'projects', projectId), { recursive: true });
  writeFileSync(
    join(dir, 'projects', projectId, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: 'u1', cwd: workspace, sessionId: SESSION, timestamp: '2026-09-10T09:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`,
  );
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

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(dir, 'skills'), { recursive: true, force: true });
  rmSync(join(workspace, '.claude'), { recursive: true, force: true });
});

describe('the skills on this machine', () => {
  test('lists the ones in the user folder with their frontmatter, and never a project folder', async () => {
    mkdirSync(join(dir, 'skills', 'write-as-less'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'write-as-less', 'SKILL.md'), skill('write-as-less', 'writes the way Less writes'));
    mkdirSync(join(workspace, '.claude', 'skills', 'ship-it'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'skills', 'ship-it', 'SKILL.md'), skill('ship-it', 'runs the gate and opens a PR'));
    mkdirSync(join(dir, 'skills', 'not-a-skill'), { recursive: true });
    mkdirSync(join(workspace, 'elsewhere'), { recursive: true });
    writeFileSync(join(workspace, 'elsewhere', 'SKILL.md'), skill('linked', 'lives behind a symlink'));
    symlinkSync(join(workspace, 'elsewhere'), join(dir, 'skills', 'linked'));
    symlinkSync(join(workspace, 'gone'), join(dir, 'skills', 'dangling'));

    const { skills } = await list();
    expect(skills.map((s) => s.id).sort()).toEqual(['user:linked', 'user:write-as-less']);
    const mine = skills.find((s) => s.name === 'write-as-less');
    expect(mine).toMatchObject({ name: 'write-as-less', title: 'write-as-less', description: 'writes the way Less writes', editable: true });
    expect(typeof mine?.updatedAt).toBe('string');
  });

  test('one is read whole, written back, and refuses a write over a change it has not seen', async () => {
    mkdirSync(join(dir, 'skills', 'morning'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'morning', 'SKILL.md'), skill('morning', 'the morning routine'));
    const read = (await (await call('GET', '/api/claude/skills/user:morning')).json()) as Skill & { text: string };
    expect(read.text).toContain('Do the thing.');

    const saved = await call('PUT', '/api/claude/skills/user:morning', { text: skill('morning', 'the new routine'), seenAt: read.updatedAt });
    expect(saved.status).toBe(200);
    expect((await saved.json() as Skill).description).toBe('the new routine');
    expect(readFileSync(join(dir, 'skills', 'morning', 'SKILL.md'), 'utf8')).toContain('the new routine');

    const stale = await call('PUT', '/api/claude/skills/user:morning', { text: skill('morning', 'racing'), seenAt: read.updatedAt });
    expect(stale.status).toBe(409);
    expect((await call('PUT', '/api/claude/skills/user:morning', { text: '   ' })).status).toBe(400);
    expect((await call('GET', '/api/claude/skills/user:missing')).status).toBe(404);
  });

  test('a new one is created from a template in the user folder, and a duplicate is refused', async () => {
    const made = await call('POST', '/api/claude/skills', { name: 'ship-it' });
    expect(made.status).toBe(200);
    expect((await made.json() as Skill).id).toBe('user:ship-it');
    expect(readFileSync(join(dir, 'skills', 'ship-it', 'SKILL.md'), 'utf8')).toContain('name: ship-it');

    expect((await call('POST', '/api/claude/skills', { name: 'ship-it' })).status).toBe(409);
    expect((await call('POST', '/api/claude/skills', { name: 'Ship It' })).status).toBe(400);
    expect((await call('POST', '/api/claude/skills', { name: '../escape' })).status).toBe(400);
  });

  test('deleting one takes its folder, and only the folder it was listed in', async () => {
    mkdirSync(join(dir, 'skills', 'old-thing'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'old-thing', 'SKILL.md'), skill('old-thing', 'gone soon'));
    writeFileSync(join(dir, 'skills', 'old-thing', 'notes.md'), 'kept beside it');
    const gone = await call('DELETE', '/api/claude/skills/user:old-thing');
    expect(gone.status).toBe(200);
    expect(existsSync(join(dir, 'skills', 'old-thing'))).toBe(false);
    expect((await call('DELETE', '/api/claude/skills/user:old-thing')).status).toBe(404);
    expect((await list()).skills).toEqual([]);
  });

  test('no session reads nothing', async () => {
    expect((await fetch(`${base}/api/claude/skills`)).status).toBe(401);
  });
});
