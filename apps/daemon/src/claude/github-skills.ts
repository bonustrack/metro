import { existsSync, readFileSync as readLocal, statSync as statLocal } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { SKILL_HASH, SKILL_MANIFEST_MAX, skillGeneration, skillRelease, skillSourceRoot, type SkillGeneration } from '@metro-labs/core/skill-source';
import { ApiError } from '@metro-labs/http/api-error';
import { readFileSync, statSync } from '../agent-user/agent-fs.js';
import { receiveHomeFile, writeHomeText } from '../agent-user/home-fs.js';
import { agentsDir } from '../agents/files.js';
import { claudeDir } from './files.js';
import { readSetupState } from './setup-state.js';
import { GitHubFailure, GitHubReader } from './github-fetch.js';
import { githubSource, validatedGeneration } from './github-validate.js';
import type { ClaudeSkill } from './skills.js';

type Configuration = ReturnType<typeof githubSource>;
interface Stored {
  source: Configuration | null;
  prepared: SkillGeneration | null;
  etag: string | null;
  checkedAt: string | null;
  retryAt: number;
  problem: string | null;
  rateLimit: number;
  repositoryId: number | null;
}
export interface GitHubSkillsDeps {
  agents: string;
  claude: string;
  sdk(): boolean;
  request?: (url: string, init: RequestInit) => Promise<Response>;
}
const EMPTY: Stored = { source: null, prepared: null, etag: null, checkedAt: null, retryAt: 0, problem: null, rateLimit: 0, repositoryId: null };
const savedString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const savedNumber = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

function readStored(path: string): Stored {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    if (statLocal(path).size > SKILL_MANIFEST_MAX * 2) throw new Error('size');
    const raw: unknown = JSON.parse(readLocal(path, 'utf8'));
    if (!isRecord(raw)) throw new Error('shape');
    return {
      source: raw.source === null ? null : githubSource(raw.source),
      prepared: raw.prepared === null ? null : skillGeneration(raw.prepared),
      etag: savedString(raw.etag), checkedAt: savedString(raw.checkedAt),
      retryAt: savedNumber(raw.retryAt), rateLimit: savedNumber(raw.rateLimit), problem: savedString(raw.problem),
      repositoryId: typeof raw.repositoryId === 'number' ? raw.repositoryId : null,
    };
  } catch { throw new Error('The saved GitHub skills source is unreadable. Restore it before changing the source.'); }
}

function agentJson(path: string): unknown {
  try {
    if (statSync(path).size > SKILL_MANIFEST_MAX) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch { return null; }
}

export class GitHubSkills {
  private readonly path: string;
  readonly root: string;
  private stored: Stored = { ...EMPTY };
  private unreadable = false;
  private busy = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: GitHubSkillsDeps) {
    this.path = join(deps.agents, 'github-skills.json');
    this.root = skillSourceRoot(deps.claude);
    try { this.stored = readStored(this.path); }
    catch { this.unreadable = true; }
  }

  private readable(): void {
    if (!this.unreadable) return;
    this.stored = readStored(this.path);
    this.unreadable = false;
  }

  private save(): void {
    this.readable();
    writeSecure(this.path, JSON.stringify(this.stored));
  }

  private activation(): { generation: string | null; appliedAt: string | null; problem: string | null; shadowed: string[] } {
    const raw = agentJson(join(this.root, 'status.json'));
    if (!isRecord(raw)) return { generation: null, appliedAt: null, problem: null, shadowed: [] };
    return {
      generation: typeof raw.generation === 'string' && SKILL_HASH.test(raw.generation) ? raw.generation : null,
      appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : null,
      problem: typeof raw.problem === 'string' ? raw.problem.slice(0, 300) : null,
      shadowed: Array.isArray(raw.shadowed) ? raw.shadowed.filter((name): name is string => typeof name === 'string').slice(0, 64) : [],
    };
  }

  private loaded(activation = this.activation()): SkillGeneration | null {
    const id = activation.generation;
    if (id === null) return null;
    try { return skillGeneration(agentJson(join(skillRelease(this.root, id), 'manifest.json'))); }
    catch { return null; }
  }

  view(activation = this.activation(), loaded = this.loaded(activation)): object {
    const { source, prepared, checkedAt, problem } = this.stored;
    return {
      supported: this.deps.sdk(),
      source: source === null ? null : { repository: source.repository, ref: source.ref, folder: source.folder, hasToken: true },
      checking: this.busy, checkedAt, problem: this.unreadable ? 'The saved GitHub source is unreadable. Restore its configuration before changing it. Local skills are still available.' : problem,
      prepared: prepared === null ? null : { generation: prepared.id, source: prepared.source, skillCount: prepared.skills.length },
      loaded: loaded?.source ?? null, activation,
      pending: prepared !== null && prepared.id !== activation.generation,
    };
  }

  listing(): { rows: ClaudeSkill[]; skillSource: object } {
    const activation = this.activation();
    const loaded = this.loaded(activation);
    return { rows: this.rows(activation, loaded), skillSource: this.view(activation, loaded) };
  }

  rows(activation = this.activation(), loaded = this.loaded(activation)): ClaudeSkill[] {
    if (loaded === null) return [];
    const origin = loaded.source;
    const shadowed = activation.shadowed;
    return loaded.skills.map((skill) => ({
      id: `github:${skill.name}`, name: skill.name, title: skill.name, description: skill.description,
      path: join(skillRelease(this.root, loaded.id), 'skills', skill.name, 'SKILL.md'), editable: false,
      updatedAt: loaded.createdAt, managed: true, shadowed: shadowed.includes(skill.name),
      ...(origin === null ? {} : { github: { repository: origin.repository, commit: origin.commit, folder: origin.folder } }),
    }));
  }

  read(id: string): ClaudeSkill & { text: string } {
    const row = this.rows().find((skill) => skill.id === id);
    if (row === undefined) throw new ApiError('no such skill', 404);
    if (statSync(row.path).size > 256 * 1024) throw new ApiError('The managed skill changed on disk. Sync it again.', 409);
    return { ...row, text: readFileSync(row.path, 'utf8') };
  }

  async configure(raw: unknown): Promise<object> {
    if (!this.deps.sdk()) throw new ApiError('GitHub skills require the Agent SDK runner. Local skills are unchanged.', 409);
    if (this.busy) throw new ApiError('A skills sync is already running. Try again when it finishes.', 409);
    const source = githubSource(raw);
    this.readable();
    const loaded = this.loaded();
    this.epoch += 1;
    this.stored = { ...this.stored, source, prepared: loaded, etag: null, retryAt: 0, problem: null, repositoryId: null };
    if (loaded === null) await this.publish(validatedGeneration(null, null), new Map(), this.epoch);
    else { this.save(); this.offer(); }
    await this.sync(true);
    return this.view();
  }

  async remove(): Promise<object> {
    this.readable();
    this.epoch += 1;
    this.stored = { ...EMPTY };
    this.save();
    await this.publish(validatedGeneration(null, null), new Map(), this.epoch);
    return this.view();
  }

  private waiting(force: boolean): boolean {
    if (Date.now() < this.stored.rateLimit) return true;
    if (force) return false;
    return Date.now() < this.stored.retryAt || (this.stored.prepared !== null && this.stored.prepared.id !== this.activation().generation);
  }

  private reader(source: Configuration, known: SkillGeneration['source'], force: boolean): ReturnType<GitHubReader['snapshot']> {
    return new GitHubReader(source, source.token, this.deps.request).snapshot(this.stored.repositoryId, force ? null : known?.commit ?? null, force ? null : this.stored.etag);
  }

  private async fetch(source: Configuration, epoch: number, force: boolean): Promise<void> {
    const previous = this.stored.prepared?.source;
    const same = previous?.repository === source.repository && previous.ref === source.ref && previous.folder === source.folder;
    const known = same ? previous : null;
    const snapshot = await this.reader(source, known, force);
    if (epoch !== this.epoch) return;
    if (snapshot !== null) {
      const generation = validatedGeneration(source, snapshot);
      this.stored.etag = snapshot.etag;
      this.stored.repositoryId = snapshot.repositoryId;
      await this.publish(generation, snapshot.files, epoch);
      if (epoch !== this.epoch) return;
    }
    this.stored.checkedAt = new Date().toISOString();
    this.stored.problem = null;
    this.stored.retryAt = Date.now() + 60_000;
  }

  async sync(force = false): Promise<void> {
    if (force && !this.deps.sdk()) throw new ApiError('GitHub skills require the Agent SDK runner. Local skills are unchanged.', 409);
    this.readable();
    this.offer();
    const source = this.stored.source;
    if (source === null || this.busy || !this.deps.sdk() || this.waiting(force)) return;
    const epoch = this.epoch;
    this.busy = true;
    try { await this.fetch(source, epoch, force); }
    catch (err) {
      if (epoch !== this.epoch) return;
      this.failure(err);
    } finally {
      this.busy = false;
      this.save();
    }
  }

  private failure(err: unknown): void {
    this.stored.problem = err instanceof GitHubFailure ? err.message : 'The repository failed skill validation or staging. Keep one folder per skill, safe metadata and regular files. The loaded skills are kept.';
    this.stored.retryAt = err instanceof GitHubFailure ? err.retryAt : Date.now() + 5 * 60_000;
    if (err instanceof GitHubFailure && err.rateLimited) this.stored.rateLimit = err.retryAt;
    this.stored.checkedAt = new Date().toISOString();
  }

  private offer(): void {
    const generation = this.stored.prepared;
    if (generation === null) return;
    const pending = agentJson(join(this.root, 'pending.json'));
    if (isRecord(pending) && pending.id === generation.id) return;
    writeHomeText(join(this.root, 'pending.json'), JSON.stringify(generation), 0o600);
  }

  private async publish(generation: SkillGeneration, files: Map<string, Buffer>, epoch: number): Promise<void> {
    const release = skillRelease(this.root, generation.id);
    const deadline = Date.now() + 120_000;
    for (const [path, bytes] of files) {
      if (epoch !== this.epoch) return;
      if (Date.now() > deadline) throw new Error('Staging skills timed out.');
      const mode = generation.files.find((file) => file.path === path)?.executable === true ? 0o700 : 0o600;
      await receiveHomeFile(join(release, 'skills', path), Readable.from(bytes), mode);
    }
    if (epoch !== this.epoch) return;
    writeHomeText(join(release, 'manifest.json'), JSON.stringify(generation), 0o600);
    this.stored.prepared = generation;
    this.save();
    this.offer();
  }

  watch(): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      this.sync().catch(() => { log.warn('github-skills: could not save sync state'); });
      this.timer = setTimeout(tick, 60_000 + Math.floor(Math.random() * 5_000));
      this.timer.unref();
    };
    tick();
  }
}

let current: GitHubSkills | null = null;
export function githubSkills(): GitHubSkills {
  current ??= new GitHubSkills({ agents: agentsDir(), claude: claudeDir(), sdk: () => readSetupState(agentsDir()).runner === 'sdk' });
  return current;
}
