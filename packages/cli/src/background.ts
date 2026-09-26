import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const AGENT_VIEW_OFF = 'CLAUDE_CODE_DISABLE_AGENT_VIEW';

const STOP_MS = 30_000;
const SETTLE_MS = 5_000;
const POLL_MS = 250;

const given = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value.trim() : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const keepInSession = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  given(env[AGENT_VIEW_OFF]) === undefined ? { ...env, [AGENT_VIEW_OFF]: '1' } : env;

const claudeDir = (env: NodeJS.ProcessEnv = process.env): string =>
  given(env.CLAUDE_CONFIG_DIR) ?? join(given(env.HOME) ?? homedir(), '.claude');

export const projectDir = (dir: string, cwd: string): string => join(dir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number, procStart?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const started = procStart === undefined ? null : startTime(pid);
  return started === null || started === procStart;
}

type Alive = (pid: number, procStart?: string) => boolean;

function backgroundEntry(file: string, alive: Alive): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(raw) || typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return null;
    if (raw.kind === 'interactive' || typeof raw.kind !== 'string') return null;
    return alive(raw.pid, typeof raw.procStart === 'string' ? raw.procStart : undefined) ? raw.sessionId : null;
  } catch {
    return null;
  }
}

export function liveBackground(sessions: string, alive: Alive = processAlive): Set<string> {
  if (!existsSync(sessions)) return new Set();
  const ids = readdirSync(sessions)
    .filter((name) => name.endsWith('.json'))
    .map((name) => backgroundEntry(join(sessions, name), alive));
  return new Set(ids.filter((id) => id !== null));
}

function newestFirst(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map((file) => file.path);
}

function continuedIn(text: string): string | null {
  const last = text.split('\n').findLast((line) => line.includes('"type":"continued-in"'));
  if (last === undefined) return null;
  try {
    const record: unknown = JSON.parse(last);
    return isRecord(record) && typeof record.continuedInSessionId === 'string' ? record.continuedInSessionId : null;
  } catch {
    return null;
  }
}

const HAS_TURN = /"type":"(user|assistant)"/;

export function heldConversation(dir: string, live: ReadonlySet<string>): string | null {
  if (live.size === 0) return null;
  for (const file of newestFirst(dir)) {
    const text = readFileSync(file, 'utf8');
    if (!HAS_TURN.test(text)) continue;
    const moved = continuedIn(text);
    if (moved !== null && live.has(moved)) return moved;
    if (!live.has(basename(file, '.jsonl'))) return null;
  }
  return null;
}

interface Stopped {
  ok: boolean;
  detail: string;
}

function stopBackground(id: string, env: NodeJS.ProcessEnv = process.env): Stopped {
  const run = spawnSync('claude', ['stop', id], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: STOP_MS });
  if (run.error !== undefined) return { ok: false, detail: run.error.message };
  const said = `${run.stdout}${run.stderr}`.trim().split('\n').at(-1) ?? '';
  return { ok: run.status === 0, detail: said === '' ? `exit ${String(run.status)}` : said };
}

interface TakeBackDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  alive?: Alive;
  stop?: (id: string, env: NodeJS.ProcessEnv) => Stopped;
  settleMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function settled(sessions: string, held: string, alive: Alive, ms: number): Promise<boolean> {
  if (!liveBackground(sessions, alive).has(held)) return true;
  if (ms <= 0) return false;
  await sleep(POLL_MS);
  return settled(sessions, held, alive, ms - POLL_MS);
}

export async function takeBackConversation(deps: TakeBackDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const alive = deps.alive ?? processAlive;
  const dir = claudeDir(env);
  const sessions = join(dir, 'sessions');
  const held = heldConversation(projectDir(dir, deps.cwd ?? process.cwd()), liveBackground(sessions, alive));
  if (held === null) return null;
  const id = held.slice(0, 8);
  const stopped = (deps.stop ?? stopBackground)(id, env);
  if (!stopped.ok || !(await settled(sessions, held, alive, deps.settleMs ?? SETTLE_MS)))
    return `the conversation is held by the Claude Code background session ${id} and it could not be stopped (${stopped.detail}), so Claude Code will refuse to continue it: run claude stop ${id}`;
  return `the conversation had moved to the Claude Code background session ${id}, where no chat reaches it; stopped that session (its conversation is kept) and continuing it here`;
}
