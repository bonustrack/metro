import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillRelease } from '@metro-labs/core/skill-source';
import { SkillWork } from '../src/skill-work.js';
import { SkillsRefresh } from '../src/skills.js';
import { currentSkills, localSkillNames, projectSkills, pruneSkills, type LocalAliases } from '../src/skills-files.js';
import { activation, skillFixture, stageSkill, until } from './skills-helper.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(timeout = 1000): ReturnType<typeof skillFixture> & { refresh: SkillsRefresh } {
  const f = skillFixture();
  const refresh = new SkillsRefresh(f.root, f.claude, timeout);
  cleanup.push(() => { refresh.close(); rmSync(f.dir, { recursive: true, force: true }); });
  return { ...f, refresh };
}

test('activation waits for safety, pauses admission synchronously and records only a successful reload', async () => {
  const f = fixture();
  const first = stageSkill(f.root);
  let safe = false;
  let finish: (() => void) | undefined;
  let calls = 0;
  f.refresh.start({ safe: () => safe, reload: () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve; }); }, wake: () => undefined });
  expect(currentSkills(f.root)).toBeNull();
  expect(calls).toBe(0);
  safe = true;
  f.refresh.check();
  expect(f.refresh.busy).toBe(true);
  expect(activation(f.root).generation).toBeNull();
  finish?.();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).generation).toBe(first.id);
  f.refresh.check();
  expect(calls).toBe(1);
});

test('body-only edits, local aliases, removal and restart preserve local files', async () => {
  const f = fixture();
  stageSkill(f.root);
  f.refresh.start({ safe: () => true, reload: async () => undefined, wake: () => undefined });
  await until(() => !f.refresh.busy);
  const second = stageSkill(f.root, 'body-only');
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).generation).toBe(second.id);
  mkdirSync(join(f.claude, 'skills/my-folder'), { recursive: true });
  const local = join(f.claude, 'skills/my-folder/SKILL.md');
  writeFileSync(local, '---\nname: team-example\ndescription: local\n---\nLOCAL');
  expect(localSkillNames(f.claude)).toEqual(['my-folder', 'team-example']);
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).shadowed).toEqual(['team-example']);
  expect(existsSync(join(f.root, '.claude/skills/team-example'))).toBe(false);
  f.refresh.close();
  const restarted = new SkillsRefresh(f.root, f.claude);
  cleanup.push(() => { restarted.close(); });
  const removed = stageSkill(f.root, '', true);
  restarted.start({ safe: () => true, reload: async () => undefined, wake: () => undefined });
  await until(() => !restarted.busy);
  expect(activation(f.root).generation).toBe(removed.id);
  expect(readFileSync(local, 'utf8')).toContain('LOCAL');
});

test('a failed reload restores the prior generation and can retry a new candidate', async () => {
  const f = fixture();
  const first = stageSkill(f.root);
  let fail = false;
  f.refresh.start({ safe: () => true, reload: async () => { if (fail) { fail = false; throw new Error('fixture'); } }, wake: () => undefined });
  await until(() => !f.refresh.busy);
  const before = currentSkills(f.root);
  const failed = stageSkill(f.root, 'second');
  fail = true;
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(currentSkills(f.root)).toBe(before);
  expect(activation(f.root).generation).toBe(first.id);
  expect(activation(f.root).problem).toContain('previous skills were restored');
  const third = stageSkill(f.root, 'third');
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).generation).toBe(third.id);
  writeFileSync(join(f.root, 'pending.json'), JSON.stringify(failed));
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).generation).toBe(failed.id);
});

test.each(['timeout', 'rejection'])('failed recovery keeps admission closed after %s', async (mode) => {
  const f = fixture(15);
  stageSkill(f.root);
  f.refresh.start({ safe: () => true, reload: () => mode === 'timeout' ? new Promise(() => undefined) : Promise.reject(new Error('fixture')), wake: () => undefined });
  await until(() => activation(f.root).problem !== null);
  expect(f.refresh.busy).toBe(true);
  expect(currentSkills(f.root)).toBeNull();
  expect(activation(f.root).generation).toBeNull();
  f.refresh.close();
  const restarted = new SkillsRefresh(f.root, f.claude);
  cleanup.push(() => { restarted.close(); });
  expect(activation(f.root).loading).toBeNull();
  restarted.start({ safe: () => true, reload: async () => undefined, wake: () => undefined });
  await until(() => !restarted.busy);
  expect(activation(f.root).generation).not.toBeNull();
});

test.each(['changed', 'extra', 'symlink'])('rejects %s staged files without altering the active link', (kind) => {
  const f = fixture();
  const generation = stageSkill(f.root);
  const dir = join(skillRelease(f.root, generation.id), 'skills/team-example');
  if (kind === 'changed') writeFileSync(join(dir, 'SKILL.md'), 'changed');
  if (kind === 'extra') writeFileSync(join(dir, 'extra.txt'), 'extra');
  if (kind === 'symlink') symlinkSync('/etc/passwd', join(dir, 'linked'));
  expect(() => projectSkills(f.root, generation, [])).toThrow();
  expect(currentSkills(f.root)).toBeNull();
});

test.each(['initial-resolve', 'initial-reject', 'update-resolve', 'update-reject'])('restart recovers an interrupted reload: %s', async (mode) => {
  const f = fixture();
  let hold = false;
  let settle: (() => void) | undefined;
  const first = stageSkill(f.root);
  const updating = mode.startsWith('update');
  if (!updating) hold = true;
  f.refresh.start({ safe: () => true, reload: () => hold ? new Promise<void>((resolve, reject) => {
    settle = () => { if (mode.endsWith('reject')) reject(new Error('closed fixture')); else resolve(); };
  }) : Promise.resolve(), wake: () => undefined });
  if (updating) {
    await until(() => !f.refresh.busy);
    hold = true;
    stageSkill(f.root, 'update');
    f.refresh.check();
  }
  expect(f.refresh.busy).toBe(true);
  f.refresh.close();
  settle?.();
  await Bun.sleep(5);
  const restarted = new SkillsRefresh(f.root, f.claude);
  cleanup.push(() => { restarted.close(); });
  expect(activation(f.root).generation).toBe(updating ? first.id : null);
  expect(activation(f.root).loading).toBeNull();
  restarted.start({ safe: () => true, reload: async () => undefined, wake: () => undefined });
  await until(() => !restarted.busy);
  expect(activation(f.root).generation).not.toBeNull();
});

test.each(['invalid', 'large', 'symlink'])('unreadable local metadata hides remote skills but cannot prevent removal: %s', async (kind) => {
  const f = fixture();
  stageSkill(f.root);
  f.refresh.start({ safe: () => true, reload: async () => undefined, wake: () => undefined });
  await until(() => !f.refresh.busy);
  const folder = join(f.claude, 'skills/local');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  if (kind === 'invalid') writeFileSync(path, '---\nname: [\n---\n');
  else if (kind === 'large') writeFileSync(path, Buffer.alloc(256 * 1024 + 1));
  else {
    const target = join(f.dir, 'huge-local');
    writeFileSync(target, Buffer.alloc(1024 * 1024));
    symlinkSync(target, path);
  }
  expect(localSkillNames(f.claude)).toContain('*');
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).shadowed).toEqual(['team-example']);
  expect(existsSync(join(f.root, '.claude/skills/team-example'))).toBe(false);
  const removed = stageSkill(f.root, '', true);
  f.refresh.check();
  await until(() => !f.refresh.busy);
  expect(activation(f.root).generation).toBe(removed.id);
  expect(existsSync(path)).toBe(true);
});

test('local alias cache follows file changes and removes deleted entries', () => {
  const f = fixture();
  const folder = join(f.claude, 'skills/local');
  const path = join(folder, 'SKILL.md');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path, '---\nname: first\n---\n');
  const cache: LocalAliases = new Map();
  expect(localSkillNames(f.claude, cache)).toEqual(['first', 'local']);
  const cached = cache.get(path);
  expect(localSkillNames(f.claude, cache)).toEqual(['first', 'local']);
  expect(cache.get(path)).toBe(cached);
  writeFileSync(path, '---\nname: replacement\n---\n');
  expect(localSkillNames(f.claude, cache)).toEqual(['local', 'replacement']);
  rmSync(folder, { recursive: true });
  expect(localSkillNames(f.claude, cache)).toEqual([]);
  expect(cache.size).toBe(0);
});

test('prunes old partial stages but keeps fresh, active, pending and foreign files', () => {
  const f = fixture();
  const active = stageSkill(f.root);
  const pending = stageSkill(f.root, 'pending');
  const old = skillRelease(f.root, 'a'.repeat(64));
  const fresh = skillRelease(f.root, 'b'.repeat(64));
  const linked = skillRelease(f.root, 'c'.repeat(64));
  const foreign = join(f.root, 'releases/local-files');
  for (const path of [old, fresh, foreign]) mkdirSync(path, { recursive: true });
  symlinkSync(foreign, linked);
  const ago = new Date(Date.now() - 6 * 60_000);
  utimesSync(old, ago, ago);
  for (const generation of [active, pending]) utimesSync(join(skillRelease(f.root, generation.id), 'manifest.json'), ago, ago);
  pruneSkills(f.root, new Set([active.id]));
  expect(existsSync(old)).toBe(false);
  for (const path of [fresh, foreign, linked, skillRelease(f.root, active.id), skillRelease(f.root, pending.id)]) expect(existsSync(path)).toBe(true);
});

test('work safety includes tools, ambient workers, paused workers and worker restart', () => {
  const work = new SkillWork();
  const system = (subtype: string, extra: object): void => { work.observe({ type: 'system', subtype, ...extra }); };
  work.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read' }] } });
  expect(work.safe).toBe(false);
  work.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read' }] } });
  expect(work.safe).toBe(true);
  system('background_tasks_changed', { tasks: [{ task_id: 'ambient', visibility: 'ambient' }] });
  expect(work.safe).toBe(false);
  system('task_notification', { task_id: 'ambient', reason: 'worker_restart', status: 'stopped' });
  expect(work.safe).toBe(true);
  system('task_updated', { task_id: 'ambient', patch: { status: 'paused' } });
  expect(work.safe).toBe(false);
  system('task_notification', { task_id: 'ambient', status: 'completed' });
  expect(work.safe).toBe(true);
});
