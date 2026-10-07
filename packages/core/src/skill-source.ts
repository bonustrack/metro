import { join } from 'node:path';
import { isRecord } from './is-record.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_HASH = /^[a-f0-9]{64}$/;
export const SKILL_COMMIT = /^[a-f0-9]{40}$/;
export const SKILL_FILE_MAX = 256 * 1024;
export const SKILL_TOTAL_MAX = 8 * 1024 * 1024;
export const SKILL_FILES_MAX = 256;
export const SKILL_MANIFEST_MAX = 128 * 1024;

export interface SkillSource {
  repository: string;
  ref: string;
  folder: string;
}

export interface SkillFile {
  path: string;
  size: number;
  sha256: string;
  executable?: boolean;
}

export interface SkillGeneration {
  id: string;
  source: (SkillSource & { repositoryId: number; commit: string }) | null;
  createdAt: string;
  skills: { name: string; description: string }[];
  files: SkillFile[];
}

export interface SkillActivation {
  generation: string | null;
  loading: string | null;
  rollback?: string | null;
  appliedAt: string | null;
  problem: string | null;
  shadowed: string[];
}

export const skillSourceRoot = (claudeDir: string): string => join(claudeDir, 'metro-github');
export const skillRelease = (root: string, id: string): string => {
  if (!SKILL_HASH.test(id)) throw new Error('Invalid skills generation.');
  return join(root, 'releases', id);
};

export function skillPath(path: string): boolean {
  const parts = path.split('/');
  return path.length <= 240 && parts.length >= 2 && parts.length <= 8 && SKILL_NAME.test(parts[0] ?? '') &&
    parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(part)) &&
    !parts.slice(1, -1).includes('SKILL.md') && !(parts.length > 2 && parts.at(-1) === 'SKILL.md');
}

function manifestSkill(value: unknown): SkillGeneration['skills'][number] {
  if (!isRecord(value) || typeof value.name !== 'string' || !SKILL_NAME.test(value.name) || typeof value.description !== 'string' || value.description.length > 1024) throw new Error('Invalid skill name or description.');
  return { name: value.name, description: value.description };
}

function fileSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > SKILL_FILE_MAX) throw new Error('Invalid skills file size.');
  return value;
}

function manifestFile(value: unknown): SkillFile {
  if (!isRecord(value)) throw new Error('Invalid skills file.');
  if (typeof value.path !== 'string' || !skillPath(value.path) || typeof value.sha256 !== 'string' || !SKILL_HASH.test(value.sha256)) throw new Error('Invalid skills file path or hash.');
  return { path: value.path, size: fileSize(value.size), sha256: value.sha256, ...(value.executable === true ? { executable: true } : {}) };
}

function manifestSource(s: unknown): SkillGeneration['source'] {
  if (s === null) return null;
  if (!isRecord(s) || typeof s.repository !== 'string' || typeof s.ref !== 'string' || typeof s.folder !== 'string' || typeof s.repositoryId !== 'number' || typeof s.commit !== 'string' || !SKILL_COMMIT.test(s.commit)) throw new Error('Invalid skills provenance.');
  return { repository: s.repository, ref: s.ref, folder: s.folder, repositoryId: s.repositoryId, commit: s.commit };
}

function checkFiles(skills: SkillGeneration['skills'], files: SkillFile[]): void {
  if (files.reduce((sum, file) => sum + file.size, 0) > SKILL_TOTAL_MAX || new Set(files.map((f) => f.path.toLowerCase())).size !== files.length || new Set(skills.map((s) => s.name)).size !== skills.length) throw new Error('Duplicate or oversized skills files.');
  if (files.some((f) => !skills.some((s) => f.path.startsWith(`${s.name}/`))) || skills.some((s) => !files.some((f) => f.path === `${s.name}/SKILL.md`))) throw new Error('Every skill needs its own SKILL.md.');
}

function boundedGeneration(generation: SkillGeneration): SkillGeneration {
  if (Buffer.byteLength(JSON.stringify(generation)) > SKILL_MANIFEST_MAX) throw new Error('Skills manifest is too large.');
  return generation;
}

export function skillGeneration(raw: unknown): SkillGeneration {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !SKILL_HASH.test(raw.id) || typeof raw.createdAt !== 'string' || !Array.isArray(raw.skills) || !Array.isArray(raw.files)) throw new Error('Invalid skills manifest.');
  if (raw.skills.length > 64 || raw.files.length > SKILL_FILES_MAX) throw new Error('Skills manifest is too large.');
  const skills = raw.skills.map(manifestSkill);
  const files = raw.files.map(manifestFile);
  const source = manifestSource(raw.source);
  checkFiles(skills, files);
  if (source === null) checkFiles([], files);
  return boundedGeneration({ id: raw.id, source, createdAt: raw.createdAt, skills, files });
}
