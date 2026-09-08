import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiError } from './api-error.js';
import { claudeDir, listClaudeProjects } from './claude-files.js';
import { isRecord } from './is-record.js';
import { errMsg } from './log.js';

export const SETTINGS_MAX = 256 * 1024;
const USER_ID = 'user';
const LOCAL_SUFFIX = '.local';
const DEFAULT_MODE = 0o644;

export type SettingsScope = 'user' | 'project' | 'local';

export interface ClaudeSettingsFile {
  id: string;
  scope: SettingsScope;
  label: string;
  path: string;
  exists: boolean;
  editable: boolean;
  text: string;
  modifiedAt: string | null;
}

const missing = (id: string, scope: SettingsScope, label: string, path: string): ClaudeSettingsFile => ({
  id,
  scope,
  label,
  path,
  exists: false,
  editable: true,
  text: '',
  modifiedAt: null,
});

function entryOf(id: string, scope: SettingsScope, label: string, path: string): ClaudeSettingsFile {
  if (!existsSync(path)) return missing(id, scope, label, path);
  const stat = statSync(path);
  const editable = stat.size <= SETTINGS_MAX;
  return {
    id,
    scope,
    label,
    path,
    exists: true,
    editable,
    text: editable ? readFileSync(path, 'utf8') : '',
    modifiedAt: stat.mtime.toISOString(),
  };
}

const PROJECT_FILES: [string, SettingsScope, string][] = [
  ['', 'project', 'settings.json'],
  [LOCAL_SUFFIX, 'local', 'settings.local.json'],
];

function projectEntries(dir: string): ClaudeSettingsFile[] {
  const out: ClaudeSettingsFile[] = [];
  for (const project of listClaudeProjects(dir)) {
    const cwd = project.cwd;
    if (cwd === null) continue;
    for (const [suffix, scope, name] of PROJECT_FILES) {
      const path = join(cwd, '.claude', name);
      if (existsSync(path)) out.push(entryOf(`${project.id}${suffix}`, scope, cwd, path));
    }
  }
  return out;
}

export function listClaudeSettings(dir = claudeDir()): ClaudeSettingsFile[] {
  return [entryOf(USER_ID, 'user', 'This machine', join(dir, 'settings.json')), ...projectEntries(dir)];
}

function assertSettingsJson(text: string): void {
  if (text.length > SETTINGS_MAX) throw new ApiError('that is more text than a settings file may hold', 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ApiError(`that is not valid JSON: ${errMsg(err)}`, 400);
  }
  if (!isRecord(parsed)) throw new ApiError('Claude Code settings must be a JSON object', 400);
}

function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return DEFAULT_MODE;
  }
}

function writeAtomic(path: string, text: string): void {
  const mode = existsSync(path) ? modeOf(path) : DEFAULT_MODE;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.metro-${String(process.pid)}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeClaudeSettings(
  id: string,
  text: string,
  seenAt: string | null | undefined,
  dir = claudeDir(),
): ClaudeSettingsFile {
  const target = listClaudeSettings(dir).find((file) => file.id === id);
  if (target === undefined) throw new ApiError('no such settings file', 404);
  if (!target.editable) throw new ApiError('that settings file is too large to edit here', 409);
  assertSettingsJson(text);
  if (seenAt !== undefined && seenAt !== target.modifiedAt)
    throw new ApiError('that file changed on disk since you opened it; reload it before saving', 409);
  writeAtomic(target.path, text);
  return entryOf(target.id, target.scope, target.label, target.path);
}
