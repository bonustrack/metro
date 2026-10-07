import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { isRecord } from '@metro-labs/core/is-record';
import { SKILL_MANIFEST_MAX, type SkillActivation, type SkillGeneration } from '@metro-labs/core/skill-source';
import { currentSkills, localSkillNames, pendingSkills, prepareSkillsRoot, projectionKey, projectSkills, pruneSkills, switchSkills, type LocalAliases } from './skills-files.js';

interface SkillHooks {
  safe(): boolean;
  reload(): Promise<unknown>;
  wake(): void;
}
const INITIAL: SkillActivation = { generation: null, loading: null, appliedAt: null, problem: null, shadowed: [] };
class ReloadTimeout extends Error {}

function savedStatus(root: string): unknown {
  const path = join(root, 'status.json');
  try {
    if (lstatSync(path).size > SKILL_MANIFEST_MAX) throw new Error('Invalid skills status.');
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) { if (isRecord(err) && err.code === 'ENOENT') return null; throw err; }
}

function repairInterrupted(root: string, raw: unknown): void {
  if (!isRecord(raw) || typeof raw.loading !== 'string') return;
  if (raw.rollback !== null && typeof raw.rollback !== 'string') throw new Error('Missing skills rollback target.');
  switchSkills(root, raw.rollback);
}

function previousStatus(root: string): SkillActivation {
  const raw = savedStatus(root);
  repairInterrupted(root, raw);
  const id = currentSkills(root)?.split('/')[2];
  if (id === undefined) return { ...INITIAL };
  if (!isRecord(raw) || raw.generation !== id || typeof raw.appliedAt !== 'string' || !Array.isArray(raw.shadowed)) throw new Error('Skills activation was interrupted.');
  return { generation: id, appliedAt: raw.appliedAt, loading: null, problem: null, shadowed: raw.shadowed.filter((name): name is string => typeof name === 'string').slice(0, 64) };
}

async function reload(hooks: SkillHooks, timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([hooks.reload(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new ReloadTimeout('Skill reload timed out.')); }, timeout);
    })]);
  } finally { clearTimeout(timer); }
}

export class SkillsRefresh {
  private hooks: SkillHooks | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly aliases: LocalAliases = new Map();
  private key: string | null = null;
  private failed: string | null = null;
  private closed = false;
  private prunedAt = 0;
  private status: SkillActivation;
  busy = false;

  constructor(readonly root: string, private readonly claude: string, private readonly timeout = 20_000) {
    prepareSkillsRoot(root);
    this.status = previousStatus(root);
    this.save();
  }

  start(hooks: SkillHooks): void {
    this.hooks = hooks;
    this.check();
    this.timer = setInterval(() => { this.check(); }, 1000);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  check(): void {
    if (this.closed || this.busy || this.hooks === null || !this.hooks.safe()) return;
    try {
      const generation = pendingSkills(this.root);
      if (generation === null) return;
      const locals = generation.skills.length === 0 ? [] : localSkillNames(this.claude, this.aliases);
      const key = projectionKey(generation, locals);
      if (this.unchanged(key)) return;
      this.busy = true;
      this.apply(generation, locals, key, this.hooks).catch(() => { this.pause(); });
    } catch {
      this.status.problem = 'The managed skills files are unreadable. The loaded skills are kept.';
      try { this.save(); } catch { this.pause(); }
    }
  }

  private unchanged(key: string): boolean {
    if (key !== this.key && key !== this.failed) return false;
    if (Date.now() - this.prunedAt > 60_000) {
      const active = currentSkills(this.root)?.split('/')[2] ?? '';
      try { pruneSkills(this.root, new Set([active])); } catch { log.warn('sdk-runner: old managed skills could not be removed'); }
      this.prunedAt = Date.now();
    }
    return true;
  }

  private save(): void { writeSecure(join(this.root, 'status.json'), JSON.stringify(this.status)); }

  private pause(): void {
    this.busy = true;
    this.status.problem = 'Skill reload could not finish safely. Input is paused. Check the files, then stop and start the Agent SDK.';
    try { this.save(); } catch { log.error('sdk-runner: skills state could not be saved; input remains paused'); }
  }

  private async recover(before: string | null, previous: SkillActivation, hooks: SkillHooks, err: unknown): Promise<void> {
    switchSkills(this.root, before);
    if (err instanceof ReloadTimeout) { this.pause(); return; }
    try {
      await reload(hooks, this.timeout);
      if (this.closed) return;
      this.status = { ...previous, loading: null, problem: 'Skill reload failed. The previous skills were restored. Sync again, or remove the source again to retry unloading.' };
      this.save();
      this.busy = false;
    } catch { this.pause(); }
  }

  private async apply(generation: SkillGeneration, locals: string[], key: string, hooks: SkillHooks): Promise<void> {
    const before = currentSkills(this.root);
    const previous = { ...this.status };
    this.status = { ...previous, loading: generation.id, rollback: before, problem: null };
    this.save();
    try {
      const projection = projectSkills(this.root, generation, locals);
      switchSkills(this.root, projection.target);
      await reload(hooks, this.timeout);
      if (this.closed) return;
      this.key = key;
      this.failed = null;
      this.status = { generation: generation.id, loading: null, appliedAt: new Date().toISOString(), problem: null, shadowed: projection.shadowed };
      this.save();
      this.busy = false;
      const keep = new Set([generation.id]);
      if (before !== null && generation.source !== null) keep.add(before.split('/')[2] ?? '');
      try { pruneSkills(this.root, keep); } catch { log.warn('sdk-runner: old managed skills could not be removed'); }
    } catch (err) {
      if (this.closed) return;
      this.failed = key;
      await this.recover(before, previous, hooks, err);
    }
    hooks.wake();
  }
}
