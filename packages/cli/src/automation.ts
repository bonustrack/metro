import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findBun, runtimeDir } from './runtime.js';

const TASK_HELP = `metro task: queue work for the existing Agent SDK conversation

  metro task submit <routine> <prompt-file> [--slot <UTC ISO timestamp>] [--dry-run]
                  queue a local prompt file (regular UTF-8 file, at most 64 KiB);
                  default slot is the current UTC hour; use --slot for other cadences;
                  accepted means saved, not executed; duplicates show their current state;
                  --dry-run writes nothing
  metro task status [routine]
                  read safe local metadata, including the token needed to finish;
                  never print prompts
  metro task finish <uuid> <token> completed|blocked
                  save a receipt pending runner verification, not mark work complete

  These commands never start a session, install a runtime or connect to the daemon.
  Local task authorization is not fresh owner approval for external actions.
`;

function taskRuntime(): { bun: string; entry: string } {
  let dir: string;
  try {
    dir = runtimeDir();
  } catch {
    throw new Error('metro task needs the shipped runtime; reinstall @stage-labs/metro@beta');
  }
  const entry = join(dir, 'sdk-runner', 'src', 'automation-cli.ts');
  if (!existsSync(entry)) throw new Error('metro task is missing its shipped entry; reinstall @stage-labs/metro@beta');
  try {
    return { bun: findBun(), entry };
  } catch {
    throw new Error('metro task needs Bun on PATH; it never installs Bun or the runner');
  }
}

export async function automationCommand(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0] ?? ''))) {
    process.stderr.write(TASK_HELP);
    return args.length === 0 ? 1 : 0;
  }
  const { bun, entry } = taskRuntime();
  return new Promise<number>((resolve) => {
    const child = spawn(bun, ['--no-install', entry, ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    });
    child.once('error', () => {
      process.stderr.write('metro task: unable to run the shipped task command\n');
      resolve(1);
    });
    child.once('exit', (code) => { resolve(code ?? 1); });
  });
}
