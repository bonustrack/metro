import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errMsg } from '@metro-labs/core/log';
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

export function removeHome(path: string, recursive = false, user = agentUser()): void {
  if (user !== null) {
    runAs(user, recursive ? 'rm -rf -- "$1"' : 'rm -f -- "$1"', [path]);
    return;
  }
  rmSync(path, { recursive, force: true });
}

export function removeHomeFiles(paths: readonly string[], user = agentUser()): void {
  if (paths.length === 0) return;
  if (user !== null) {
    runAs(user, 'rm -f -- "$@"', [...paths]);
    return;
  }
  for (const path of paths) rmSync(path, { force: true });
}

export function moveHome(from: string, to: string, user = agentUser()): void {
  if (user !== null) {
    runAs(user, 'mv -f -- "$1" "$2"', [from, to]);
    return;
  }
  renameSync(from, to);
}

interface Ran {
  stdout: string;
  failure: Error | null;
}

function ranOf(child: ChildProcess): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise<Ran>((resolve) => {
    child.on('error', (err) => {
      resolve({ stdout, failure: err });
    });
    child.on('close', (status) => {
      resolve({ stdout, failure: status === 0 ? null : new Error(stderr.trim() || `exit ${String(status)}`) });
    });
  });
}

async function receiveAs(user: AgentUser, path: string, source: Readable, mode: number): Promise<void> {
  const [file, argv] = asUser(user, 'sh', ['-c', WRITE, 'metro', path, octal(mode), '']);
  const child = spawn(file, argv, { stdio: ['pipe', 'ignore', 'pipe'] });
  const ran = ranOf(child);
  const piped = await pipeline(source, child.stdin).then(
    () => null,
    (err: unknown) => err,
  );
  const { failure } = await ran;
  if (piped !== null) throw piped instanceof Error ? piped : new Error(errMsg(piped));
  if (failure !== null) throw new Error(`as ${user.name}: ${failure.message}`);
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

const COPY = [
  'set -e',
  'src=$(realpath -- "$1")',
  'if [ "$src" != "$1" ]; then case "$src" in "$2"/*) ;; *) exit 3 ;; esac; fi',
  '[ -f "$src" ]',
  'mkdir -p -- "$(dirname -- "$3")"',
  'tmp=$(mktemp -- "$3.metro-XXXXXX")',
  'trap \'rm -f -- "$tmp"\' EXIT',
  'head -c "$(($4 + 1))" -- "$src" > "$tmp"',
  'size=$(wc -c < "$tmp" | tr -d " ")',
  '[ "$size" -le "$4" ]',
  'chmod 600 "$tmp"',
  'mv -f -- "$tmp" "$3"',
  'trap - EXIT',
  'printf "%s" "$size"',
].join('\n');

export async function copyIntoHome(from: string, to: string, home: string, max: number, user = agentUser()): Promise<number> {
  const [file, argv] = asUser(user, 'sh', ['-c', COPY, 'metro', from, home, to, String(max)]);
  const ran = await ranOf(spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'] }));
  const size = Number(ran.stdout);
  if (ran.failure !== null || !Number.isInteger(size) || ran.stdout === '') throw new Error('the file could not be copied as the agent');
  return size;
}

const SWEEP = [
  '[ -d "$1" ] && [ ! -L "$1" ] || exit 0',
  'find -P "$1" -mindepth 1 ! -type d -mmin +"$2" -print -delete',
  'find -P "$1" -mindepth 1 -type d -empty -mmin +"$3" -delete',
].join('\n');

export async function sweepHome(dir: string, olderMinutes: number, emptyMinutes: number, user = agentUser()): Promise<number> {
  const [file, argv] = asUser(user, 'sh', ['-c', SWEEP, 'metro', dir, String(olderMinutes), String(emptyMinutes)]);
  const ran = await ranOf(spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'] }));
  if (ran.failure !== null) throw new Error('old files could not be removed as the agent');
  return ran.stdout.split('\n').filter((line) => line !== '').length;
}
