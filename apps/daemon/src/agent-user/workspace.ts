import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { repairGitLinks } from './git-links.js';
import { asUser, type AgentUser } from './user.js';

const SKIPPED = new Set(['snap', 'lost+found']);
const SAFE_HIDDEN = [
  '.cache/huggingface/hub',
  '.cache/whisper',
  '.cache/torch',
  '.cache/ms-playwright',
  '.venv',
  '.venvs',
  '.virtualenvs',
  '.pyenv',
  '.bun',
  '.nvm',
  '.cargo',
  '.rustup',
  '.deno',
];
const SIZE_MS = 2_000;
const SIZES_BUDGET_MS = 6_000;
const NAMES_MAX = 1_000;

export type EntryState = 'here' | 'waiting' | 'copying' | 'moved' | 'failed';
export type MoveMode = 'copy' | 'move';

export interface WorkspaceEntry {
  name: string;
  kind: 'folder' | 'file' | 'link';
  hidden: boolean;
  bytes: number | null;
  state: EntryState;
  error: string | null;
}

interface Job {
  state: 'waiting' | 'copying' | 'failed';
  error: string | null;
}

const jobs = new Map<string, Job>();
let queue: Promise<void> = Promise.resolve();

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

const present = (path: string): boolean => kindOf(path) !== null;

function sizeOf(path: string): number | null {
  const run = spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: SIZE_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  const kb = Number(run.stdout.split('\t')[0]);
  return run.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

export function candidates(from = homedir()): string[] {
  const visible = readdirSync(from).filter((name) => !name.startsWith('.') && !SKIPPED.has(name));
  const hidden = SAFE_HIDDEN.filter((name) => kindOf(join(from, name)) === 'folder');
  return [...visible.sort((a, b) => a.localeCompare(b)), ...hidden];
}

function stateOf(name: string, user: AgentUser): Pick<WorkspaceEntry, 'state' | 'error'> {
  const job = jobs.get(name);
  if (job !== undefined) return { state: job.state, error: job.error };
  return { state: present(join(user.home, name)) ? 'moved' : 'here', error: null };
}

export function listWorkspace(user: AgentUser, from = homedir(), now = Date.now): WorkspaceEntry[] {
  const until = now() + SIZES_BUDGET_MS;
  return candidates(from).flatMap((name): WorkspaceEntry[] => {
    const path = join(from, name);
    const kind = kindOf(path);
    if (kind === null) return [];
    const bytes = kind === 'file' ? lstatSync(path).size : kind === 'folder' && now() < until ? sizeOf(path) : null;
    return [{ name, kind, hidden: name.startsWith('.'), bytes, ...stateOf(name, user) }];
  });
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

function makeParents(user: AgentUser, target: string): void {
  const parent = dirname(target);
  if (parent === user.home || existsSync(parent)) return;
  const [file, args] = asUser(user, 'mkdir', ['-p', '--', parent]);
  spawnSync(file, args, { stdio: 'ignore' });
}

const sameDisk = (a: string, b: string): boolean => statSync(a).dev === statSync(b).dev;

async function putBack(staged: string, source: string): Promise<void> {
  if (present(staged) && !present(source)) await run('mv', ['-T', '--', staged, source]);
}

async function place(name: string, user: AgentUser, from: string, mode: MoveMode): Promise<void> {
  const source = join(from, name);
  const target = join(user.home, name);
  const staging = mkdtempSync(join(user.home, '..', '.metro-move-'));
  const staged = join(staging, 'entry');
  try {
    if (mode === 'move') await run('mv', ['-T', '--', source, staged]);
    else await run('cp', ['-a', '--', source, staged]);
    await run('chown', ['-hR', `${String(user.uid)}:${String(user.gid)}`, staged]);
    makeParents(user, target);
    if (present(target)) throw new Error(`${target} already exists; move or remove it first`);
    await run('mv', ['-T', '--', staged, target]);
  } catch (err) {
    if (mode === 'move') await putBack(staged, source);
    throw err;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function moveOne(name: string, user: AgentUser, from: string, mode: MoveMode): Promise<void> {
  await place(name, user, from, mode);
  jobs.delete(name);
  await repairGitLinks(user, from);
  log.info({ name, mode, user: user.name }, "agent-user: an entry from root's home now belongs to the agent user");
}

function wantedNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length === 0 || names.length > NAMES_MAX || !names.every((n) => typeof n === 'string'))
    throw new ApiError('names must be a list of entries from the list', 400);
  return [...new Set(names)];
}

export function modeOf(raw: unknown): MoveMode {
  if (raw === undefined || raw === 'copy') return 'copy';
  if (raw === 'move') return 'move';
  throw new ApiError('mode must be copy or move', 400);
}

function assertMovable(name: string, listed: ReadonlySet<string>, user: AgentUser): void {
  if (!listed.has(name)) throw new ApiError(`${name} is not an entry metro offers to move`, 400);
  const job = jobs.get(name)?.state;
  if (job === 'copying' || job === 'waiting') throw new ApiError(`${name} is already being moved`, 409);
  if (present(join(user.home, name))) throw new ApiError(`${name} already exists in ${user.home}`, 409);
}

export function startMove(names: unknown, user: AgentUser, mode: MoveMode = 'copy', from = homedir()): string[] {
  const wanted = wantedNames(names);
  const listed = new Set(candidates(from));
  for (const name of wanted) assertMovable(name, listed, user);
  if (mode === 'move' && !sameDisk(from, dirname(user.home))) throw new ApiError(`${from} is on another disk than ${user.home}; copy instead`, 400);
  for (const name of wanted) {
    jobs.set(name, { state: 'waiting', error: null });
    queue = queue.then(async () => {
      jobs.set(name, { state: 'copying', error: null });
      await moveOne(name, user, from, mode).catch((err: unknown) => {
        jobs.set(name, { state: 'failed', error: errMsg(err) });
        log.warn({ name, err: errMsg(err) }, 'agent-user: could not move an entry to the agent user');
      });
    });
  }
  return wanted;
}
