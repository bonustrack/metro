import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillRelease } from '@metro-labs/core/skill-source';
import { GitHubSkills } from '../src/claude/github-skills.js';
import { GitHubReader } from '../src/claude/github-fetch.js';
import { githubSource } from '../src/claude/github-validate.js';
import { COMMIT, FakeGitHub, fixture, skill, SOURCE } from './github-skills-helper.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const make = (): ReturnType<typeof fixture> => { const f = fixture(); dirs.push(f.dir); return f; };
const manifest = (root: string): { id: string; source: { commit: string } | null; files: { path: string; sha256: string }[] } => JSON.parse(readFileSync(join(root, 'pending.json'), 'utf8')) as ReturnType<typeof manifest>;

function acknowledge(root: string): void {
  const generation = manifest(root).id;
  writeFileSync(join(root, 'status.json'), JSON.stringify({ generation, appliedAt: new Date().toISOString(), shadowed: [] }));
}

describe('bounded private GitHub skills source', () => {
  test('stages immutable provenance without running scripts or copying its token to the agent', async () => {
    const { dir, source, github } = make();
    const view = await source.configure(SOURCE);
    const pending = manifest(source.root);
    expect(pending.source?.commit).toBe(COMMIT);
    expect(pending.files).toHaveLength(2);
    expect(pending.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(JSON.stringify(view)).not.toContain(SOURCE.token);
    expect(readFileSync(join(source.root, 'pending.json'), 'utf8')).not.toContain(SOURCE.token);
    const release = skillRelease(source.root, pending.id);
    expect(readFileSync(join(release, 'manifest.json'), 'utf8')).not.toContain(SOURCE.token);
    expect(statSync(join(release, 'skills/team-example/scripts/task.sh')).mode & 0o111).toBe(0);
    expect(statSync(join(dir, 'daemon/github-skills.json')).mode & 0o777).toBe(0o600);
    expect(github.calls.every(({ url, init }) => url.startsWith('https://api.github.com/repos/example/skills') && init.redirect === 'manual')).toBe(true);
    expect(source.rows()).toEqual([]);
    acknowledge(source.root);
    const githubOrigin = { repository: SOURCE.repository, commit: COMMIT, folder: SOURCE.folder };
    expect(source.rows()[0]).toMatchObject({ id: 'github:team-example', editable: false, managed: true, github: githubOrigin });
    expect(source.read('github:team-example').github).toEqual(githubOrigin);
    expect(source.read('github:team-example').text).toContain('Do the task.');
  });

  test('row and detail provenance follow only the acknowledged generation through staging, replacement and removal', async () => {
    const { source, github } = make();
    await source.configure(SOURCE);
    acknowledge(source.root);
    const origin = { repository: SOURCE.repository, commit: COMMIT, folder: SOURCE.folder };
    const generation = manifest(source.root).id;
    github.commit = 'b'.repeat(40);
    github.files.set('team-example/SKILL.md', skill('team-example', 'staged instructions'));
    await source.sync(true);
    expect(manifest(source.root).source?.commit).toBe(github.commit);
    expect(source.listing().rows[0]?.github).toEqual(origin);
    expect(source.read('github:team-example').github).toEqual(origin);
    expect(source.read('github:team-example').text).not.toContain('staged instructions');
    github.status = 401;
    await source.configure({ ...SOURCE, repository: 'replacement/repo', ref: 'new/ref', folder: 'other/folder' });
    expect(source.rows()[0]?.github).toEqual(origin);
    writeFileSync(join(source.root, 'status.json'), JSON.stringify({ generation, shadowed: ['team-example'] }));
    expect(source.rows()[0]).toMatchObject({ shadowed: true, github: origin });
    await source.remove();
    expect(source.read('github:team-example').github).toEqual(origin);
    acknowledge(source.root);
    expect(source.rows()).toEqual([]);
  });

  test('keeps local skills and last good state on access loss, network failure and invalid updates', async () => {
    const { dir, source, github } = make();
    const local = join(dir, 'claude/skills/team-example/SKILL.md');
    mkdirSync(join(dir, 'claude/skills/team-example'), { recursive: true });
    writeFileSync(local, 'local owner instructions');
    await source.configure(SOURCE);
    acknowledge(source.root);
    const first = manifest(source.root).id;
    github.status = 401;
    await source.sync(true);
    expect(JSON.stringify(source.view())).toContain('access was refused');
    expect(JSON.stringify(source.view())).not.toContain(SOURCE.token);
    expect(manifest(source.root).id).toBe(first);
    github.status = 200;
    github.files.set('team-example/SKILL.md', skill('team-example', '!`touch /tmp/never-run`'));
    await source.sync(true);
    expect(manifest(source.root).id).toBe(first);
    expect(JSON.stringify(source.view())).toContain('failed skill validation');
    const restarted = new GitHubSkills({ agents: join(dir, 'daemon'), claude: join(dir, 'claude'), sdk: () => true, request: github.fetch });
    expect(restarted.rows()).toHaveLength(1);
    await restarted.remove();
    expect(manifest(source.root).source).toBeNull();
    expect(readFileSync(join(dir, 'daemon/github-skills.json'), 'utf8')).not.toContain(SOURCE.token);
    expect(readFileSync(local, 'utf8')).toBe('local owner instructions');
    expect(restarted.rows()).toHaveLength(1);
    acknowledge(source.root);
    expect(restarted.rows()).toEqual([]);
  });

  test.each(['120000', '160000', '100664'])('rejects non-regular mode %s before any blobs are fetched', async (mode) => {
    const github = new FakeGitHub();
    github.changeRows = (rows) => rows.map((row) => ({ ...row, mode }));
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('Symlinks, submodules and special files');
    expect(github.calls.some(({ url }) => url.includes('/blobs/'))).toBe(false);
  });

  test.each(['../escape/SKILL.md', '/etc/SKILL.md', 'team-example/../../escape', 'team-example/.claude/settings.json', 'team-example/nested/SKILL.md', 'team-example/a\\b'])('rejects unsafe repository path %s', async (path) => {
    const github = new FakeGitHub();
    github.changeRows = (rows) => rows.map((row) => ({ ...row, path }));
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('path or file size');
  });

  test.each(['hooks: {}', 'allowed-tools: Bash', 'model: another-model', 'context: fork', 'agent: worker'])('rejects active skill metadata %s', async (field) => {
    const { source, github } = make();
    github.files.set('team-example/SKILL.md', Buffer.from(`---\nname: team-example\ndescription: x\n${field}\n---\nDo it.`));
    const view = await source.configure(SOURCE);
    expect(JSON.stringify(view)).toContain('failed skill validation');
    expect(manifest(source.root).source).toBeNull();
  });

  test('rejects truncated trees, oversized files, excessive file counts and case collisions', async () => {
    const github = new FakeGitHub();
    github.truncated = true;
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('incomplete');
    github.truncated = false;
    github.changeRows = (rows) => rows.map((row) => ({ ...row, size: 256 * 1024 + 1 }));
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('file size');
    github.changeRows = (rows) => Array.from({ length: 257 }, (_, index) => ({ ...rows[0]!, path: `team-example/file-${index}` }));
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('256 files');
    github.changeRows = (rows) => [...rows, { ...rows[0]!, path: 'team-example/skill.md' }];
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('duplicate');
  });

  test('uses conditional ref reads and refuses changed repository identities and redirects', async () => {
    const github = new FakeGitHub();
    expect(await new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(42, COMMIT, github.etag)).toBeNull();
    expect(github.calls).toHaveLength(2);
    github.repositoryId = 99;
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(42, null, null)).rejects.toThrow('identity changed');
    github.status = 302;
    await expect(new GitHubReader(SOURCE, SOURCE.token, github.fetch).snapshot(null, null, null)).rejects.toThrow('could not provide');
  });

  test('repairs a pending publication from durable prepared state before waiting for acknowledgement', async () => {
    const { dir, source, github } = make();
    await source.configure(SOURCE);
    const prepared = manifest(source.root);
    rmSync(join(source.root, 'pending.json'));
    const calls = github.calls.length;
    const restarted = new GitHubSkills({ agents: join(dir, 'daemon'), claude: join(dir, 'claude'), sdk: () => true, request: github.fetch });
    await restarted.sync();
    expect(manifest(source.root)).toEqual(prepared);
    expect(github.calls.length).toBe(calls);
  });

  test.each([true, false])('a failed replacement never leaves a superseded pending revision eligible, loaded=%s', async (loaded) => {
    const { source, github } = make();
    await source.configure(SOURCE);
    const first = manifest(source.root);
    if (loaded) acknowledge(source.root);
    github.commit = 'b'.repeat(40);
    github.files.set('team-example/SKILL.md', skill('team-example', 'not loaded yet'));
    await source.sync(true);
    const superseded = manifest(source.root).id;
    github.status = 401;
    await source.configure({ ...SOURCE, ref: 'replacement' });
    const replacement = manifest(source.root);
    expect(replacement.id).not.toBe(superseded);
    if (loaded) expect(replacement).toEqual(first);
    else expect(replacement.source).toBeNull();
    expect(JSON.stringify(source.view())).toContain('access was refused');
  });

  test('explicit reconnect accepts a recreated repository but unattended sync refuses it', async () => {
    const { source, github } = make();
    await source.configure(SOURCE);
    acknowledge(source.root);
    const first = manifest(source.root).id;
    github.repositoryId = 99;
    await source.sync(true);
    expect(manifest(source.root).id).toBe(first);
    expect(JSON.stringify(source.view())).toContain('identity changed');
    await source.configure(SOURCE);
    expect(manifest(source.root).id).not.toBe(first);
    expect(JSON.stringify(source.view())).toContain('"repositoryId":99');
    expect(JSON.stringify(source.view())).not.toContain('identity changed');
  });

  test('rejects a Unicode manifest exceeding its byte limit without publishing it', async () => {
    const { source, github } = make();
    await source.configure(SOURCE);
    acknowledge(source.root);
    const first = manifest(source.root).id;
    github.files = new Map(Array.from({ length: 64 }, (_, index) => {
      const name = `skill-${index}`;
      return [`${name}/SKILL.md`, Buffer.from(`---\nname: ${name}\ndescription: ${'界'.repeat(1024)}\n---\nInstructions`)];
    }));
    await source.sync(true);
    expect(manifest(source.root).id).toBe(first);
    expect(JSON.stringify(source.view())).toContain('failed skill validation');
  });

  test('preserves owner execution permission without running an executable resource', async () => {
    const { dir, source, github } = make();
    const marker = join(dir, 'must-not-run');
    github.files.set('team-example/scripts/task.sh', Buffer.from(`#!/bin/sh\nprintf executed > '${marker}'\n`));
    github.changeRows = (rows) => rows.map((row) => ({ ...row, mode: row.path.endsWith('.sh') ? '100755' : '100644' }));
    await source.configure(SOURCE);
    const release = skillRelease(source.root, manifest(source.root).id);
    expect(statSync(join(release, 'skills/team-example/scripts/task.sh')).mode & 0o777).toBe(0o700);
    expect(existsSync(marker)).toBe(false);
    const commitRead = github.calls.find(({ url }) => url.includes('/commits/main'));
    expect(new Headers(commitRead?.init.headers).get('accept')).toBe('application/vnd.github.sha');
    expect(github.calls.some(({ url }) => url.endsWith(`/git/commits/${COMMIT}`))).toBe(true);
  });

  test('downloads resources with bounded parallelism', async () => {
    const github = new FakeGitHub();
    for (let index = 0; index < 12; index += 1) github.files.set(`team-example/file-${index}`, Buffer.from(`file ${index}`));
    let active = 0;
    let maximum = 0;
    const request = async (url: string, init: RequestInit): Promise<Response> => {
      if (!url.includes('/git/blobs/')) return github.fetch(url, init);
      active += 1;
      maximum = Math.max(maximum, active);
      try { await Bun.sleep(5); return await github.fetch(url, init); }
      finally { active -= 1; }
    };
    const snapshot = await new GitHubReader(SOURCE, SOURCE.token, request).snapshot(null, null, null);
    expect(snapshot?.files.size).toBe(github.files.size);
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });

  test('refuses unsupported harnesses and input credential/path injection', async () => {
    const { dir, github } = make();
    const source = new GitHubSkills({ agents: join(dir, 'other'), claude: join(dir, 'cli'), sdk: () => false, request: github.fetch });
    await expect(source.configure(SOURCE)).rejects.toThrow('Agent SDK');
    expect(github.calls).toHaveLength(0);
    for (const patch of [{ repository: 'https://evil.example/a/b' }, { repository: 'a/b?secret=x' }, { ref: '../main' }, { folder: '../skills' }, { folder: '/skills' }, { token: 'token\r\nHost: evil' }]) expect(() => githubSource({ ...SOURCE, ...patch })).toThrow();
  });
});
