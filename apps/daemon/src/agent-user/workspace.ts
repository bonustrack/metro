import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import type { AgentUser } from './user.js';

const SKIPPED = new Set(['snap', 'lost+found']);
const SIZE_MS = 4_000;
const NAMES_MAX = 100;

export type EntryState = 'here' | 'copying' | 'moved' | 'failed';

export interface WorkspaceEntry {
  name: string;
  kind: 'folder' | 'file' | 'link';
  bytes: number | null;
  state: EntryState;
  error: string | null;
}

interface Job {
  state: 'copying' | 'failed';
  error: string | null;
}

const jobs = new Map<string, Job>();

const offered = (name: string): boolean => !name.startsWith('.') && !SKIPPED.has(name) && !name.includes('/');

function kindOf(path: string): WorkspaceEntry['kind'] | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'link';
    if (stat.isDirectory()) return 'folder';
    return stat.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

function sizeOf(path: string): number | null {
  const run = spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: SIZE_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  const kb = Number(run.stdout.split('\t')[0]);
  return run.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

const present = (path: string): boolean => kindOf(path) !== null;

function stateOf(name: string, user: AgentUser): Pick<WorkspaceEntry, 'state' | 'error'> {
  const job = jobs.get(name);
  if (job !== undefined) return { state: job.state, error: job.error };
  return { state: present(join(user.home, name)) ? 'moved' : 'here', error: null };
}

export function listWorkspace(user: AgentUser, from = homedir()): WorkspaceEntry[] {
  return readdirSync(from)
    .filter(offered)
    .flatMap((name): WorkspaceEntry[] => {
      const path = join(from, name);
      const kind = kindOf(path);
      if (kind === null) return [];
      return [{ name, kind, bytes: kind === 'link' ? null : sizeOf(path), ...stateOf(name, user) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => {
      said = `${said}${chunk.toString('utf8')}`.slice(-1000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file}: ${said.trim() || `exit ${String(code)}`}`));
    });
  });
}

async function moveOne(name: string, user: AgentUser, from: string): Promise<void> {
  const staging = mkdtempSync(join(user.home, '..', '.metro-move-'));
  try {
    const staged = join(staging, name);
    await run('cp', ['-a', '--', join(from, name), staged]);
    await run('chown', ['-hR', `${String(user.uid)}:${String(user.gid)}`, staged]);
    const target = join(user.home, name);
    if (present(target)) throw new Error(`${target} already exists; move or remove it first`);
    await run('mv', ['-T', '--', staged, target]);
    jobs.delete(name);
    log.info({ name, user: user.name }, 'agent-user: moved a folder from root\'s home to the agent user');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function wantedNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length === 0 || names.length > NAMES_MAX || !names.every((n) => typeof n === 'string'))
    throw new ApiError('names must be a list of entries from the list', 400);
  return [...new Set(names)];
}

function assertMovable(name: string, listed: ReadonlySet<string>, user: AgentUser): void {
  if (!listed.has(name)) throw new ApiError(`${name} is not an entry metro offers to move`, 400);
  if (jobs.get(name)?.state === 'copying') throw new ApiError(`${name} is already being moved`, 409);
  if (present(join(user.home, name))) throw new ApiError(`${name} already exists in ${user.home}`, 409);
}

export function startMove(names: unknown, user: AgentUser, from = homedir()): string[] {
  const wanted = wantedNames(names);
  const listed = new Set(readdirSync(from).filter(offered));
  for (const name of wanted) assertMovable(name, listed, user);
  for (const name of wanted) {
    jobs.set(name, { state: 'copying', error: null });
    moveOne(name, user, from).catch((err: unknown) => {
      jobs.set(name, { state: 'failed', error: errMsg(err) });
      log.warn({ name, err: errMsg(err) }, 'agent-user: could not move a folder to the agent user');
    });
  }
  return wanted;
}
