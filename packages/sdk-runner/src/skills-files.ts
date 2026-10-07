import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, lstatSync, statSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { SKILL_FILE_MAX, SKILL_HASH, SKILL_MANIFEST_MAX, skillGeneration, skillRelease, type SkillGeneration } from '@metro-labs/core/skill-source';

const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const LINK = /^\.\.\/releases\/[a-f0-9]{64}\/visible-[a-f0-9]{64}$/;

function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error('The managed skills directory is not a regular directory.');
}

export function prepareSkillsRoot(root: string): void {
  directory(root);
  directory(join(root, 'releases'));
  directory(join(root, '.claude'));
}

export function pendingSkills(root: string): SkillGeneration | null {
  const path = join(root, 'pending.json');
  let stat;
  try { stat = lstatSync(path); } catch (err) { if (isRecord(err) && err.code === 'ENOENT') return null; throw err; }
  if (!stat.isFile() || stat.size > SKILL_MANIFEST_MAX) throw new Error('Invalid pending skills manifest.');
  return skillGeneration(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function localText(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SKILL_FILE_MAX) throw new Error('A local skill cannot be checked safely.');
    const bytes = Buffer.alloc(SKILL_FILE_MAX + 1);
    let size = 0;
    for (;;) {
      const read = readSync(fd, bytes, size, bytes.length - size, size);
      if (read === 0) break;
      size += read;
      if (size === bytes.length) break;
    }
    if (size > SKILL_FILE_MAX) throw new Error('A local skill is too large.');
    return bytes.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}

export type LocalAliases = Map<string, { signature: string; name: string | null }>;

function localAlias(file: string, cache: LocalAliases): string | null {
  try {
    const stat = statSync(file);
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = cache.get(file);
    if (cached?.signature === signature) return cached.name;
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(localText(file))?.[1];
    const meta: unknown = header === undefined ? null : Bun.YAML.parse(header);
    const name = isRecord(meta) && typeof meta.name === 'string' ? meta.name : null;
    cache.set(file, { signature, name });
    return name;
  } catch (err) { return isRecord(err) && ['ENOENT', 'ENOTDIR'].includes(String(err.code)) ? null : '*'; }
}

export function localSkillNames(claude: string, cache: LocalAliases = new Map()): string[] {
  const names = new Set<string>();
  let folders: string[];
  try { folders = readdirSync(join(claude, 'skills')); } catch (err) { if (isRecord(err) && err.code === 'ENOENT') return []; throw err; }
  if (folders.length > 2000) return ['*'];
  const paths = new Set<string>();
  for (const name of folders) {
    names.add(name);
    const path = join(claude, 'skills', name, 'SKILL.md');
    paths.add(path);
    const alias = localAlias(path, cache);
    if (alias !== null) names.add(alias);
  }
  for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
  return [...names].sort();
}

export function projectionKey(generation: SkillGeneration, locals: string[]): string {
  return `${generation.id}:${digest(JSON.stringify(locals))}`;
}

function onlyManifestFiles(root: string, generation: SkillGeneration): void {
  const files = new Set(generation.files.map((file) => file.path));
  const directories = new Set(generation.files.flatMap((file) => file.path.split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join('/'))));
  const visit = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const relative = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.isDirectory() && directories.has(relative)) visit(relative);
      else if (!entry.isFile() || !files.has(relative)) throw new Error('Unexpected file in staged skills.');
    }
  };
  visit('');
}

function verifiedFiles(release: string, generation: SkillGeneration): void {
  directory(release);
  directory(join(release, 'skills'));
  onlyManifestFiles(join(release, 'skills'), generation);
  for (const file of generation.files) {
    let parent = join(release, 'skills');
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      if (!lstatSync(parent).isDirectory()) throw new Error('A managed skill contains a linked directory.');
    }
    const path = join(release, 'skills', file.path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== file.size || digest(readFileSync(path)) !== file.sha256) throw new Error('A staged skill changed before activation.');
  }
}

export function projectSkills(root: string, generation: SkillGeneration, locals: string[]): { target: string; shadowed: string[] } {
  prepareSkillsRoot(root);
  const release = skillRelease(root, generation.id);
  verifiedFiles(release, generation);
  const shadowed = generation.skills.filter((skill) => locals.includes('*') || locals.includes(skill.name)).map((skill) => skill.name);
  const name = `visible-${digest(JSON.stringify(locals))}`;
  const visible = join(release, name);
  directory(visible);
  const expected = generation.skills.filter((skill) => !shadowed.includes(skill.name)).map((skill) => skill.name);
  if (readdirSync(visible).some((entry) => !expected.includes(entry))) throw new Error('Unexpected file in skills projection.');
  for (const skill of generation.skills) {
    if (shadowed.includes(skill.name)) continue;
    const path = join(visible, skill.name);
    try { symlinkSync(`../skills/${skill.name}`, path, 'dir'); }
    catch (err) { if (!isRecord(err) || err.code !== 'EEXIST' || readlinkSync(path) !== `../skills/${skill.name}`) throw err; }
  }
  return { target: `../releases/${generation.id}/${name}`, shadowed };
}

export function currentSkills(root: string): string | null {
  try {
    const target = readlinkSync(join(root, '.claude', 'skills'));
    if (!LINK.test(target)) throw new Error('The managed skills link has an unexpected target.');
    return target;
  } catch (err) { if (isRecord(err) && err.code === 'ENOENT') return null; throw err; }
}

export function switchSkills(root: string, target: string | null): void {
  prepareSkillsRoot(root);
  const link = join(root, '.claude', 'skills');
  currentSkills(root);
  if (target === null) { rmSync(link, { force: true }); return; }
  if (!LINK.test(target)) throw new Error('Invalid managed skills target.');
  const next = `${link}-${randomUUID()}`;
  try { symlinkSync(target, next, 'dir'); renameSync(next, link); }
  finally { rmSync(next, { force: true }); }
}

function oldRelease(path: string): boolean {
  let stat;
  try { stat = lstatSync(join(path, 'manifest.json')); }
  catch (err) { if (!isRecord(err) || err.code !== 'ENOENT') throw err; stat = lstatSync(path); }
  return Date.now() - stat.mtimeMs > 5 * 60_000;
}

export function pruneSkills(root: string, keep: Set<string>): void {
  const pending = pendingSkills(root);
  if (pending !== null) keep.add(pending.id);
  for (const id of readdirSync(join(root, 'releases'))) {
    if (!SKILL_HASH.test(id) || keep.has(id)) continue;
    const release = skillRelease(root, id);
    if (!lstatSync(release).isDirectory()) continue;
    try {
      if (oldRelease(release)) rmSync(release, { recursive: true });
    } catch (err) { if (!isRecord(err) || err.code !== 'ENOENT') throw err; }
  }
}
