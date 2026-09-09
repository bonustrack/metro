import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { ApiError } from '@metro-labs/http/api-error';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
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
  scope: string;
  where: string;
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

const list = async (): Promise<{ skills: Skill[]; places: { id: string; where: string }[] }> =>
  (await (await call('GET', '/api/claude/skills')).json()) as { skills: Skill[]; places: { id: string; where: string }[] };

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
  test('lists the ones on disk with their frontmatter, and names the places a new one can go', async () => {
    mkdirSync(join(dir, 'skills', 'write-as-less'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'write-as-less', 'SKILL.md'), skill('write-as-less', 'writes the way Less writes'));
    mkdirSync(join(workspace, '.claude', 'skills', 'ship-it'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'skills', 'ship-it', 'SKILL.md'), skill('ship-it', 'runs the gate and opens a PR'));
    mkdirSync(join(dir, 'skills', 'not-a-skill'), { recursive: true });

    const { skills, places } = await list();
    expect(skills.map((s) => s.id).sort()).toEqual([`${projectId}:ship-it`, 'user:write-as-less']);
    const mine = skills.find((s) => s.id === 'user:write-as-less');
    expect(mine).toMatchObject({ name: 'write-as-less', title: 'write-as-less', description: 'writes the way Less writes', scope: 'user', where: 'This machine', editable: true });
    expect(typeof mine?.updatedAt).toBe('string');
    expect(skills.find((s) => s.id === `${projectId}:ship-it`)?.where).toBe(workspace);
    expect(places.map((p) => p.id)).toEqual(['user', projectId]);
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

  test('a new one is created from a template, in the place asked for, and a duplicate is refused', async () => {
    const made = await call('POST', '/api/claude/skills', { name: 'ship-it' });
    expect(made.status).toBe(200);
    expect((await made.json() as Skill).id).toBe('user:ship-it');
    expect(readFileSync(join(dir, 'skills', 'ship-it', 'SKILL.md'), 'utf8')).toContain('name: ship-it');

    const inProject = await call('POST', '/api/claude/skills', { name: 'ship-it', scope: projectId, text: skill('ship-it', 'here') });
    expect((await inProject.json() as Skill).where).toBe(workspace);
    expect(existsSync(join(workspace, '.claude', 'skills', 'ship-it', 'SKILL.md'))).toBe(true);

    expect((await call('POST', '/api/claude/skills', { name: 'ship-it' })).status).toBe(409);
    expect((await call('POST', '/api/claude/skills', { name: 'Ship It' })).status).toBe(400);
    expect((await call('POST', '/api/claude/skills', { name: '../escape' })).status).toBe(400);
    expect((await call('POST', '/api/claude/skills', { name: 'ok', scope: 'nowhere' })).status).toBe(404);
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

  test('a stranger reads, writes and deletes nothing', async () => {
    mkdirSync(join(dir, 'skills', 'private-thing'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'private-thing', 'SKILL.md'), skill('private-thing', 'mine'));
    expect((await call('GET', '/api/claude/skills', undefined, STRANGER)).status).toBe(404);
    expect((await call('PUT', '/api/claude/skills/user:private-thing', { text: skill('x', 'y') }, STRANGER)).status).toBe(404);
    expect((await call('DELETE', '/api/claude/skills/user:private-thing', undefined, STRANGER)).status).toBe(404);
    expect((await fetch(`${base}/api/claude/skills`)).status).toBe(401);
    expect(existsSync(join(dir, 'skills', 'private-thing', 'SKILL.md'))).toBe(true);
  });
});
