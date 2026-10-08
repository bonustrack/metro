import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { GitHubSkills } from '../src/claude/github-skills.js';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { auth, TEST_OWNER } from './identity-helper.js';
import { fixture, SOURCE } from './github-skills-helper.js';

const f = fixture();
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    if (!handleClaudeRequest(req, res, { dir: () => join(f.dir, 'claude'), skillSource: f.source })) res.writeHead(404).end();
  });
  const port = 10000 + Math.floor(Math.random() * 19000);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  rmSync(f.dir, { recursive: true, force: true });
});
const request = async (method: string, path: string, who: 'admin' | 'member' | 'agent', body?: unknown): Promise<Response> => fetch(`${base}/api/claude/${path}`, {
  method, headers: { authorization: who === 'agent' ? 'Bearer agent-key-not-a-human-session' : await auth(TEST_OWNER, who), 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('only a human administrator can write, sync or remove a GitHub skills source', async () => {
  for (const method of ['PUT', 'POST', 'DELETE']) {
    for (const path of ['skill-source', '/skill-source', '///skill-source//']) expect((await request(method, path, 'member', method === 'PUT' ? SOURCE : undefined)).status).toBe(403);
    expect((await request(method, 'skill-source', 'agent', method === 'PUT' ? SOURCE : undefined)).status).toBe(401);
  }
  expect(f.github.calls).toHaveLength(0);
  const response = await request('PUT', 'skill-source', 'admin', SOURCE);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(SOURCE.token);
  const listing = await request('GET', 'skills', 'member');
  expect(listing.status).toBe(200);
  const body = await listing.text();
  expect(body).toContain('skillSource');
  expect(body).not.toContain(SOURCE.token);
  for (const method of ['PUT', 'DELETE']) expect((await request(method, 'skills/github:team-example', 'admin', method === 'PUT' ? { text: 'overwrite' } : undefined)).status).toBe(409);
  expect((await request('PUT', 'skill-source/unexpected', 'member', SOURCE)).status).toBe(403);
  expect((await request('DELETE', 'skill-source', 'admin')).status).toBe(200);
});

test('corrupt optional source state does not prevent local skill CRUD or erase the saved secret', async () => {
  const path = join(f.dir, 'daemon/github-skills.json');
  const broken = `{bad:${SOURCE.token}`;
  writeFileSync(path, broken);
  f.source = new GitHubSkills({ agents: join(f.dir, 'daemon'), claude: join(f.dir, 'claude'), sdk: () => true, request: f.github.fetch });
  expect((await request('POST', 'skills', 'member', { name: 'local', text: 'local instructions' })).status).toBe(200);
  const listing = await request('GET', 'skills', 'member');
  expect(listing.status).toBe(200);
  const text = await listing.text();
  expect(text).toContain('Local skills are still available');
  expect(text).not.toContain(SOURCE.token);
  const local = await request('GET', 'skills/user:local', 'member');
  expect(local.status).toBe(200);
  expect(await local.json()).not.toHaveProperty('github');
  expect((await request('PUT', 'skills/user:local', 'member', { text: 'changed' })).status).toBe(200);
  expect((await request('DELETE', 'skills/user:local', 'member')).status).toBe(200);
  expect((await request('PUT', 'skill-source', 'admin', SOURCE)).status).toBe(500);
  expect(readFileSync(path, 'utf8')).toBe(broken);
});
