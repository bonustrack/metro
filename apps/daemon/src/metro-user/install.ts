import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HELPER_PATH, helperScript, SUDOERS_PATH, sudoersText } from './helper-script.js';
import { AGENT_NAME } from '../agent-user/user.js';

interface InstallPaths {
  helper: string;
  sudoers: string;
}

function checked(file: string, args: string[]): void {
  const run = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${`${run.stdout}${run.stderr}`.trim() || `exit ${String(run.status)}`}`);
}

export function installRootHelper(paths: InstallPaths = { helper: HELPER_PATH, sudoers: SUDOERS_PATH }): void {
  mkdirSync(dirname(paths.helper), { recursive: true, mode: 0o755 });
  writeFileSync(paths.helper, helperScript(), { mode: 0o755 });
  chmodSync(paths.helper, 0o755);
  const work = mkdtempSync(join(tmpdir(), 'metro-sudoers-'));
  try {
    const draft = join(work, 'metro');
    writeFileSync(draft, sudoersText(AGENT_NAME), { mode: 0o440 });
    checked('visudo', ['-cf', draft]);
    checked('install', ['-m', '440', draft, paths.sudoers]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  installRootHelper();
  process.stdout.write(`metro: wrote ${HELPER_PATH} and ${SUDOERS_PATH}\n`);
}
