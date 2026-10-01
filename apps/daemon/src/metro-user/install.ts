import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HELPER_PATH,
  helperScript,
  IMDS_UNIT,
  IMDS_UNIT_PATH,
  imdsUnitText,
  SUDOERS_PATH,
  sudoersText,
  UPGRADE_UNIT_PATH,
  upgradeUnitText,
} from './helper-script.js';
import { AGENT_NAME } from '../agent-user/user.js';

interface InstallPaths {
  helper: string;
  sudoers: string;
}

type Run = (file: string, args: string[]) => void;

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

export function installImdsGuard(unit: string = IMDS_UNIT_PATH, run: Run = checked): void {
  writeFileSync(unit, imdsUnitText(), { mode: 0o644 });
  chmodSync(unit, 0o644);
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', IMDS_UNIT]);
  run('systemctl', ['restart', IMDS_UNIT]);
}

const PLAIN_PATH = /^\/[A-Za-z0-9_./+-]+$/;

export function installUpgradeUnit(node: string, unit: string = UPGRADE_UNIT_PATH, run: Run = checked): void {
  if (!PLAIN_PATH.test(node)) throw new Error(`the root upgrade needs node by a plain absolute path, not '${node}'`);
  writeFileSync(unit, upgradeUnitText(node), { mode: 0o644 });
  chmodSync(unit, 0o644);
  run('systemctl', ['daemon-reload']);
}

export function nodeArg(argv: string[]): string {
  const at = argv.indexOf('--node');
  const node = at < 0 ? undefined : argv[at + 1];
  if (node === undefined) throw new Error('usage: install.ts --node <absolute path of the node that runs the root upgrade>');
  return node;
}

if (import.meta.main) {
  const node = nodeArg(process.argv.slice(2));
  installRootHelper();
  installImdsGuard();
  installUpgradeUnit(node);
  process.stdout.write(
    `metro: wrote ${HELPER_PATH}, ${SUDOERS_PATH}, ${IMDS_UNIT_PATH} and ${UPGRADE_UNIT_PATH}; only root and metro reach the instance metadata service, and the root side follows every update\n`,
  );
}
