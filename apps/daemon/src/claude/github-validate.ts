import { createHash, randomUUID } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { SKILL_NAME, skillGeneration, type SkillGeneration, type SkillSource } from '@metro-labs/core/skill-source';
import { ApiError } from '@metro-labs/http/api-error';
import type { GitHubSnapshot } from './github-fetch.js';

const FIELDS = new Set(['name', 'description', 'argument-hint', 'disable-model-invocation', 'user-invocable']);
export const skillDigest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function validRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//');
}

function validFolder(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 240) return false;
  if (value === '') return true;
  const parts = value.split('/');
  return parts.length <= 6 && parts.every((part) => /^[A-Za-z0-9._-]{1,80}$/.test(part) && part !== '.' && part !== '..');
}

export function githubSource(raw: unknown): SkillSource & { token: string } {
  if (!isRecord(raw) || typeof raw.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw.repository)) throw new ApiError('Use a GitHub repository in owner/repository form.', 400);
  if (!validRef(raw.ref)) throw new ApiError('Use a branch, tag or full commit SHA.', 400);
  if (!validFolder(raw.folder)) throw new ApiError('Use a relative skills folder, or leave it empty for the repository root.', 400);
  if (typeof raw.token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,240}$/.test(raw.token)) throw new ApiError('Use a fine-grained GitHub token with Contents read access to this repository only.', 400);
  return { repository: raw.repository, ref: raw.ref, folder: raw.folder, token: raw.token };
}

function passiveMetadata(meta: Record<string, unknown>): void {
  if (Object.keys(meta).some((key) => !FIELDS.has(key))) throw new Error('Unsupported skill metadata. Only name, description, argument-hint, disable-model-invocation and user-invocable are allowed. Hooks, tool grants, model changes and agents are not imported.');
  if (['disable-model-invocation', 'user-invocable'].some((key) => key in meta && typeof meta[key] !== 'boolean') || ('argument-hint' in meta && typeof meta['argument-hint'] !== 'string')) throw new Error('Invalid skill metadata types.');
}

function skillMetadata(name: string, bytes: Buffer): { name: string; description: string } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null || /!`|\0/.test(text)) throw new Error('A skill needs YAML frontmatter. Shell substitutions are not supported.');
  const meta: unknown = Bun.YAML.parse(match[1] ?? '');
  if (!isRecord(meta) || meta.name !== name || !SKILL_NAME.test(name) || typeof meta.description !== 'string' || meta.description.trim() === '' || meta.description.length > 1024) throw new Error('A skill needs a name matching its folder and a description of up to 1024 characters.');
  passiveMetadata(meta);
  return { name, description: meta.description };
}

export function validatedGeneration(source: SkillSource | null, snapshot: GitHubSnapshot | null): SkillGeneration {
  const files = snapshot?.files ?? new Map<string, Buffer>();
  const skills = [...files].filter(([path]) => path.endsWith('/SKILL.md')).map(([path, bytes]) => skillMetadata(path.split('/')[0] ?? '', bytes));
  const manifest = {
    source: source === null || snapshot === null ? null : { repository: source.repository, ref: source.ref, folder: source.folder, repositoryId: snapshot.repositoryId, commit: snapshot.commit },
    skills,
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: skillDigest(bytes), ...(snapshot?.executables?.includes(path) === true ? { executable: true } : {}) })),
  };
  return skillGeneration({ ...manifest, id: skillDigest(randomUUID()), createdAt: new Date().toISOString() });
}
