import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeAtomic } from '@metro-labs/core/secure-fs';
import { agentUser, asUser, type AgentUser } from './user.js';

const WRITE = [
  'set -e',
  'mkdir -p -- "$(dirname -- "$1")"',
  'tmp=$(mktemp -- "$1.metro-XXXXXX")',
  'trap \'rm -f -- "$tmp"\' EXIT',
  'cat > "$tmp"',
  'chmod -- "$2" "$tmp"',
  'if [ -n "$3" ]; then touch -d "@$3" -- "$tmp"; fi',
  'mv -f -- "$tmp" "$1"',
  'trap - EXIT',
].join('\n');

const octal = (mode: number): string => mode.toString(8);
const epoch = (mtime: Date | undefined): string => (mtime === undefined ? '' : String(Math.floor(mtime.getTime() / 1000)));

function runAs(user: AgentUser, script: string, args: string[], input?: string): void {
  const [file, argv] = asUser(user, 'sh', ['-c', script, 'metro', ...args]);
  const run = spawnSync(file, argv, { input, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`as ${user.name}: ${run.stderr.trim() || `exit ${String(run.status)}`}`);
}

export function writeHomeText(path: string, text: string, mode = 0o644, mtime?: Date, user = agentUser()): void {
  if (user !== null) {
    runAs(user, WRITE, [path, octal(mode), epoch(mtime)], text);
    return;
  }
  writeAtomic(path, text, mode);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}

export function writeHomeInPlace(path: string, text: string, mode = 0o644, user = agentUser()): void {
  if (user !== null) {
    runAs(user, 'mkdir -p -- "$(dirname -- "$1")"; cat > "$1"; chmod -- "$2" "$1"', [path, octal(mode)], text);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}

function filesUnder(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const inner = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(root, inner);
    return entry.isFile() ? [inner] : [];
  });
}

export function copyIntoHome(from: string, to: string, user = agentUser()): number {
  removeHome(to, true, user);
  const files = filesUnder(from);
  for (const rel of files) {
    const source = join(from, rel);
    writeHomeText(join(to, rel), readFileSync(source, 'utf8'), statSync(source).mode & 0o777, undefined, user);
  }
  return files.length;
}

export function removeHome(path: string, recursive = false, user = agentUser()): void {
  if (user !== null) {
    runAs(user, recursive ? 'rm -rf -- "$1"' : 'rm -f -- "$1"', [path]);
    return;
  }
  rmSync(path, { recursive, force: true });
}

export function moveHome(from: string, to: string, user = agentUser()): void {
  if (user !== null) {
    runAs(user, 'mv -f -- "$1" "$2"', [from, to]);
    return;
  }
  renameSync(from, to);
}

async function receiveAs(user: AgentUser, path: string, source: Readable, mode: number): Promise<void> {
  const [file, argv] = asUser(user, 'sh', ['-c', WRITE, 'metro', path, octal(mode), '']);
  const child = spawn(file, argv, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await pipeline(source, child.stdin);
  const status = await closed;
  if (status !== 0) throw new Error(`as ${user.name}: ${stderr.trim() || `exit ${String(status)}`}`);
}

export async function receiveHomeFile(path: string, source: Readable, mode = 0o600, user = agentUser()): Promise<void> {
  if (user !== null) {
    await receiveAs(user, path, source, mode);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.metro-${String(process.pid)}.part`;
  try {
    await pipeline(source, createWriteStream(tmp, { mode }));
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
