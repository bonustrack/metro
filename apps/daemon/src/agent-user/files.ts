import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { asUser, type AgentUser } from './user.js';

type EntryKind = 'folder' | 'file' | 'other';

interface FileEntry {
  name: string;
  kind: EntryKind;
  bytes: number;
  modifiedAt: string;
}

export type FilesAnswer =
  | { root: string; path: string; kind: 'folder'; entries: FileEntry[]; more: boolean }
  | { root: string; path: string; kind: 'file'; bytes: number; modifiedAt: string; text: string | null; truncated: boolean };

const MAX_ENTRIES = 2000;
const PREVIEW_BYTES = 256 * 1024;
const SNIFF_BYTES = 8192;

const SCRIPT = [
  'if [ -d "$1" ]; then',
  '  printf "D\\0"; find -H "$1" -mindepth 1 -maxdepth 1 -printf "%y\\0%s\\0%T@\\0%f\\0"',
  'elif [ -f "$1" ]; then',
  '  printf "F\\0"; stat -L -c "%s %Y" -- "$1" | tr "\\n" "\\0"; head -c "$2" -- "$1"',
  'else',
  '  echo "no such file or folder" >&2; exit 2',
  'fi',
].join('\n');

export function segmentsOf(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0')))
    throw new ApiError('that path is not inside the home folder', 400);
  return parts;
}

const stamp = (seconds: number): string => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '');

const kindOf = (letter: string): EntryKind => (letter === 'd' ? 'folder' : letter === 'f' ? 'file' : 'other');

const byKindThenName = (a: FileEntry, b: FileEntry): number =>
  a.kind === 'folder' && b.kind !== 'folder' ? -1 : b.kind === 'folder' && a.kind !== 'folder' ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function preview(bytes: Buffer, size: number): { text: string | null; truncated: boolean } {
  const binary = bytes.subarray(0, SNIFF_BYTES).includes(0);
  return { text: binary ? null : bytes.subarray(0, PREVIEW_BYTES).toString('utf8'), truncated: size > PREVIEW_BYTES };
}

function folderAnswer(root: string, path: string, entries: FileEntry[]): FilesAnswer {
  const sorted = entries.sort(byKindThenName);
  return { root, path, kind: 'folder', entries: sorted.slice(0, MAX_ENTRIES), more: sorted.length > MAX_ENTRIES };
}

function parseListing(out: Buffer): FileEntry[] {
  const fields = out.toString('utf8').split('\0');
  const entries: FileEntry[] = [];
  for (let at = 0; at + 3 < fields.length; at += 4)
    entries.push({ kind: kindOf(fields[at] ?? ''), bytes: Number(fields[at + 1]), modifiedAt: stamp(Number(fields[at + 2])), name: fields[at + 3] ?? '' });
  return entries;
}

function parseFile(root: string, path: string, out: Buffer): FilesAnswer {
  const end = out.indexOf(0);
  const [size = '0', mtime = '0'] = out.subarray(0, end).toString('utf8').trim().split(' ');
  const bytes = Number(size);
  return { root, path, kind: 'file', bytes, modifiedAt: stamp(Number(mtime)), ...preview(out.subarray(end + 1), bytes) };
}

function readAsAgent(user: AgentUser, path: string): FilesAnswer {
  const target = join(user.home, ...segmentsOf(path));
  const [file, argv] = asUser(user, 'sh', ['-c', SCRIPT, 'metro', target, String(PREVIEW_BYTES + 1)]);
  const run = spawnSync(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  if (run.error !== undefined) throw new ApiError(`could not read that path: ${run.error.message}`, 500);
  if (run.status !== 0) throw new ApiError(run.stderr.toString('utf8').trim() || 'the agent cannot read that path', 404);
  return answerOf(user.home, path, run.stdout);
}

export function answerOf(root: string, path: string, out: Buffer): FilesAnswer {
  const body = out.subarray(2);
  return out.subarray(0, 1).toString() === 'D' ? folderAnswer(root, path, parseListing(body)) : parseFile(root, path, body);
}

export function readAgentPath(user: AgentUser | null, path: string): FilesAnswer {
  if (user === null) throw new ApiError('Claude Code does not run as its own user on this machine, so there is no agent folder to show', 409);
  return readAsAgent(user, path);
}
