import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { claudeDir, listClaudeProjects } from './files.js';

export const SKILL_MAX = 256 * 1024;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USER_SCOPE = 'user';
const FILE = 'SKILL.md';
const DEFAULT_MODE = 0o644;
const SUMMARY_MAX = 300;

export type SkillScope = 'user' | 'project';

export interface ClaudeSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  scope: SkillScope;
  where: string;
  path: string;
  editable: boolean;
  updatedAt: string | null;
}

const frontmatterField = (text: string, field: string): string => {
  const head = text.startsWith('---') ? text.slice(3, text.indexOf('\n---', 3)) : '';
  for (const line of head.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0 && line.slice(0, at).trim() === field) return line.slice(at + 1).trim().replace(/^["']|["']$/g, '').slice(0, SUMMARY_MAX);
  }
  return '';
};

function entryOf(id: string, name: string, scope: SkillScope, where: string, path: string): ClaudeSkill {
  const stat = statSync(path);
  const editable = stat.size <= SKILL_MAX;
  const text = editable ? readFileSync(path, 'utf8') : '';
  return {
    id,
    name,
    title: frontmatterField(text, 'name') || name,
    description: frontmatterField(text, 'description'),
    scope,
    where,
    path,
    editable,
    updatedAt: stat.mtime.toISOString(),
  };
}

function skillsIn(root: string, prefix: string, scope: SkillScope, where: string): ClaudeSkill[] {
  if (!existsSync(root)) return [];
  const out: ClaudeSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
    const path = join(root, entry.name, FILE);
    if (existsSync(path)) out.push(entryOf(`${prefix}:${entry.name}`, entry.name, scope, where, path));
  }
  return out;
}

export const userSkillsRoot = (dir: string): string => join(dir, 'skills');

export interface SkillHome {
  prefix: string;
  scope: SkillScope;
  where: string;
  root: string;
}

export function skillHomes(dir = claudeDir()): SkillHome[] {
  const homes: SkillHome[] = [{ prefix: USER_SCOPE, scope: USER_SCOPE, where: 'This machine', root: userSkillsRoot(dir) }];
  for (const project of listClaudeProjects(dir)) {
    const cwd = project.cwd;
    if (cwd === null || !existsSync(cwd)) continue;
    homes.push({ prefix: project.id, scope: 'project', where: cwd, root: join(cwd, '.claude', 'skills') });
  }
  return homes;
}

export function listClaudeSkills(dir = claudeDir()): ClaudeSkill[] {
  const out = skillHomes(dir).flatMap((home) => skillsIn(home.root, home.prefix, home.scope, home.where));
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name));
}

function found(id: string, dir: string): ClaudeSkill {
  const skill = listClaudeSkills(dir).find((entry) => entry.id === id);
  if (skill === undefined) throw new ApiError('no such skill', 404);
  return skill;
}

export function readClaudeSkill(id: string, dir = claudeDir()): ClaudeSkill & { text: string } {
  const skill = found(id, dir);
  return { ...skill, text: skill.editable ? readFileSync(skill.path, 'utf8') : '' };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.metro-${String(process.pid)}`;
  writeFileSync(tmp, text, { mode: DEFAULT_MODE });
  renameSync(tmp, path);
}

function assertText(text: string): void {
  if (text.length > SKILL_MAX) throw new ApiError('that is more text than a skill may hold', 413);
  if (text.trim() === '') throw new ApiError('a skill needs some text', 400);
}

export function writeClaudeSkill(
  id: string,
  text: string,
  seenAt: string | null | undefined,
  dir = claudeDir(),
): ClaudeSkill {
  const skill = found(id, dir);
  if (!skill.editable) throw new ApiError('that skill is too large to edit here', 409);
  assertText(text);
  if (seenAt !== undefined && seenAt !== skill.updatedAt)
    throw new ApiError('that skill changed on disk since you opened it; reload it before saving', 409);
  writeAtomic(skill.path, text);
  return entryOf(skill.id, skill.name, skill.scope, skill.where, skill.path);
}

export const skillTemplate = (name: string): string =>
  ['---', `name: ${name}`, 'description: what this skill does, and when Claude should reach for it', '---', '', `# ${name}`, '', 'Write the instructions here.', ''].join('\n');

export function createClaudeSkill(
  name: string,
  scope: string | undefined,
  text: string | undefined,
  dir = claudeDir(),
): ClaudeSkill {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name))
    throw new ApiError('a skill name is lowercase letters, digits and dashes, up to 64 characters', 400);
  const prefix = scope === undefined || scope === '' ? USER_SCOPE : scope;
  const home = skillHomes(dir).find((h) => h.prefix === prefix);
  if (home === undefined) throw new ApiError('no such place to keep a skill', 404);
  const path = join(home.root, name, FILE);
  if (existsSync(path)) throw new ApiError('a skill by that name already lives there', 409);
  const body = text === undefined || text.trim() === '' ? skillTemplate(name) : text;
  assertText(body);
  writeAtomic(path, body);
  return entryOf(`${home.prefix}:${name}`, name, home.scope, home.where, path);
}

export function deleteClaudeSkill(id: string, dir = claudeDir()): string {
  const skill = found(id, dir);
  const folder = dirname(skill.path);
  if (basename(folder) !== skill.name) throw new ApiError('that skill does not live in its own folder', 409);
  rmSync(folder, { recursive: true, force: true });
  return id;
}
