import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AutomationError, automationRequest, assertRoutine, AUTOMATION_PROMPT_MAX } from '@metro-labs/core/automation-types';
import type { AutomationRequest } from '@metro-labs/core/automation-types';
import type { AutomationStore } from '@metro-labs/core/automation-store';

const HOUR_MS = 3_600_000;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class AutomationCommandError extends Error {}

export interface AutomationCommandDeps {
  store: Pick<AutomationStore, 'validate' | 'submit' | 'requests' | 'statuses' | 'finish'>;
  now?: () => number;
  readPrompt?: (path: string) => string;
}

export function automationShellCommand(args: readonly string[], runtime: { executable?: string; entry?: string } = {}): string {
  const executable = runtime.executable ?? process.execPath;
  const entry = runtime.entry ?? fileURLToPath(new URL('./automation-cli.ts', import.meta.url));
  const quoted = [executable, '--no-install', entry, ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`);
  return `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 ${quoted.join(' ')}`;
}

export function automationRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() ?? '';
  const state = env.METRO_RUNNER_STATE?.trim() ?? '';
  const path = state === '' ? join(home === '' ? homedir() : home, '.metro', 'agent-session.json') : state;
  return join(dirname(path), 'automation');
}

function regularPromptPath(path: string): string {
  const full = resolve(path);
  let at = full;
  for (;;) {
    const stat = lstatSync(at);
    if (stat.isSymbolicLink() || (at !== full && !stat.isDirectory()))
      throw new AutomationCommandError('prompt file must not use symbolic links');
    const parent = dirname(at);
    if (parent === at) return full;
    at = parent;
  }
}

export function readAutomationPrompt(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(regularPromptPath(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > AUTOMATION_PROMPT_MAX)
      throw new AutomationCommandError('prompt must be a regular UTF-8 file of at most 64 KiB');
    const buffer = Buffer.alloc(AUTOMATION_PROMPT_MAX + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, size);
      if (read === 0) break;
      size += read;
    }
    if (size > AUTOMATION_PROMPT_MAX)
      throw new AutomationCommandError('prompt must be a regular UTF-8 file of at most 64 KiB');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } catch (err) {
    if (err instanceof AutomationCommandError) throw err;
    throw new AutomationCommandError('cannot read prompt as a regular UTF-8 file without symbolic links');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function slotTime(text: string): number {
  const slot = Date.parse(text);
  if (!SLOT_RE.test(text) || !Number.isFinite(slot) || new Date(slot).toISOString() !== text.replace(/:([0-9]{2})Z$/, ':$1.000Z'))
    throw new AutomationCommandError('--slot must be a valid UTC ISO timestamp ending in Z');
  return slot;
}

function submitFlags(flags: string[]): { slot: number | undefined; dryRun: boolean } {
  let slot: number | undefined;
  let dryRun = false;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (flag === '--dry-run' && !dryRun) dryRun = true;
    else if (flag === '--slot' && slot === undefined && value !== undefined) {
      slot = slotTime(value);
      i += 1;
    } else throw new AutomationCommandError('invalid or repeated submit option');
  }
  return { slot, dryRun };
}

function submitOptions(args: string[], now: number): { routine: string; path: string; slot: number; dryRun: boolean } {
  const [routine, path, ...flags] = args;
  if (routine === undefined || path === undefined || path.startsWith('--'))
    throw new AutomationCommandError('submit needs <routine> <prompt-file> [--slot <UTC ISO timestamp>] [--dry-run]');
  assertRoutine(routine);
  const { slot, dryRun } = submitFlags(flags);
  return { routine, path, slot: slot ?? Math.floor(now / HOUR_MS) * HOUR_MS, dryRun };
}

function metadata(request: AutomationRequest): Omit<AutomationRequest, 'prompt' | 'digest'> {
  return { version: 1, routine: request.routine, slot: request.slot, uuid: request.uuid, createdAt: request.createdAt };
}

function submitTask(args: string[], deps: AutomationCommandDeps): object {
  const now = (deps.now ?? Date.now)();
  const { routine, path, slot, dryRun } = submitOptions(args, now);
  const prompt = (deps.readPrompt ?? readAutomationPrompt)(path);
  const request = automationRequest(routine, slot, prompt, now);
  deps.store.validate();
  if (dryRun) return { status: 'validated', queued: false, dryRun: true, ...metadata(request) };
  const saved = deps.store.submit(routine, slot, prompt);
  const state = deps.store.statuses().find((status) => status.uuid === saved.uuid)?.state ?? 'pending';
  return { status: 'accepted', queued: state === 'pending', state, ...metadata(saved) };
}

function taskStatus(args: string[], deps: AutomationCommandDeps): object {
  if (args.length > 1) throw new AutomationCommandError('status accepts only an optional routine');
  const routine = args[0];
  if (routine !== undefined) assertRoutine(routine);
  deps.store.validate();
  const statuses = new Map(deps.store.statuses().map((status) => [status.uuid, status]));
  const tasks = deps.store.requests().filter((request) => routine === undefined || request.routine === routine).map((request) => {
    const status = statuses.get(request.uuid);
    return { ...metadata(request), state: status?.state ?? 'pending', token: status?.token ?? null, updatedAt: status?.updatedAt ?? null, ...(status?.detail === undefined ? {} : { detail: status.detail }) };
  });
  return { tasks };
}

function finishTask(args: string[], deps: AutomationCommandDeps): object {
  const [uuid, token, outcome] = args;
  if (args.length !== 3 || uuid === undefined || token === undefined || (outcome !== 'completed' && outcome !== 'blocked'))
    throw new AutomationCommandError('finish needs <uuid> <token> completed|blocked');
  const receipt = deps.store.finish(uuid, token, outcome);
  return { status: 'accepted', verification: 'pending', uuid: receipt.uuid, requestedOutcome: receipt.outcome, createdAt: receipt.createdAt };
}

export async function runAutomationCommand(args: string[], deps: AutomationCommandDeps): Promise<object> {
  const [command, ...rest] = args;
  if (command === 'submit') return Promise.resolve(submitTask(rest, deps));
  if (command === 'status') return Promise.resolve(taskStatus(rest, deps));
  if (command === 'finish') return Promise.resolve(finishTask(rest, deps));
  throw new AutomationCommandError('expected submit, status or finish; run metro task --help');
}

export function automationCommandFailure(err: unknown): string {
  if (err instanceof AutomationCommandError || err instanceof AutomationError) return err.message.slice(0, 240);
  return 'task operation failed; check the private local automation directory';
}
