import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { claudeDir } from './files.js';
import { removeHome, writeHomeText } from '../agent-user/home-fs.js';

export const SKILL_MAX = 256 * 1024;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE = 'SKILL.md';
const DEFAULT_MODE = 0o644;
const SUMMARY_MAX = 300;

export interface ClaudeSkill {
  id: string;
  name: string;
  title: string;
  description: string;
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

function entryOf(name: string, path: string): ClaudeSkill {
  const stat = statSync(path);
  const editable = stat.size <= SKILL_MAX;
  const text = editable ? readFileSync(path, 'utf8') : '';
  return {
    id: `user:${name}`,
    name,
    title: frontmatterField(text, 'name') || name,
    description: frontmatterField(text, 'description'),
    path,
    editable,
    updatedAt: stat.mtime.toISOString(),
  };
}

export const userSkillsRoot = (dir: string): string => join(dir, 'skills');

const isFolder = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export function listClaudeSkills(dir = claudeDir()): ClaudeSkill[] {
  const root = userSkillsRoot(dir);
  if (!existsSync(root)) return [];
  const out: ClaudeSkill[] = [];
  for (const name of readdirSync(root)) {
    if (!SKILL_NAME_RE.test(name) || !isFolder(join(root, name))) continue;
    const path = join(root, name, FILE);
    if (existsSync(path)) out.push(entryOf(name, path));
  }
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
  writeHomeText(skill.path, text, DEFAULT_MODE);
  return entryOf(skill.name, skill.path);
}

export const skillTemplate = (name: string): string =>
  ['---', `name: ${name}`, 'description: what this skill does, and when Claude should reach for it', '---', '', `# ${name}`, '', 'Write the instructions here.', ''].join('\n');

export function createClaudeSkill(name: string, text: string | undefined, dir = claudeDir()): ClaudeSkill {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name))
    throw new ApiError('a skill name is lowercase letters, digits and dashes, up to 64 characters', 400);
  const path = join(userSkillsRoot(dir), name, FILE);
  if (existsSync(path)) throw new ApiError('a skill by that name already lives there', 409);
  const body = text === undefined || text.trim() === '' ? skillTemplate(name) : text;
  assertText(body);
  writeHomeText(path, body, DEFAULT_MODE);
  return entryOf(name, path);
}

export function deleteClaudeSkill(id: string, dir = claudeDir()): string {
  const skill = found(id, dir);
  const folder = dirname(skill.path);
  if (basename(folder) !== skill.name) throw new ApiError('that skill does not live in its own folder', 409);
  removeHome(folder, true);
  return id;
}
