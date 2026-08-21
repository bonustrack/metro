import { spawnSync } from 'node:child_process';
import {
  currentVersion,
  isNewer,
  PACKAGE_NAME,
  publishedVersion,
} from './version.js';

export type Manager = 'bun' | 'npm';

export function managerFor(location: string): Manager {
  return location.includes('/.bun/') ? 'bun' : 'npm';
}

export function installArgs(manager: Manager, version: string): string[] {
  const spec = `${PACKAGE_NAME}@${version}`;
  return manager === 'bun'
    ? ['add', '--global', spec]
    : ['install', '--global', spec];
}

export async function update(): Promise<number> {
  const current = currentVersion();
  const newest = await publishedVersion();
  if (newest === '') {
    process.stderr.write('npm published no version this CLI understands\n');
    return 1;
  }
  if (!isNewer(newest, current)) {
    process.stderr.write(`metro ${current} is the newest published version\n`);
    return 0;
  }
  const manager = managerFor(import.meta.url);
  const args = installArgs(manager, newest);
  process.stderr.write(
    `Updating metro ${current} to ${newest} with ${manager}\n`,
  );
  const run = spawnSync(manager, args, { stdio: 'inherit' });
  if (run.error !== undefined || run.status !== 0) {
    process.stderr.write(
      `That did not work. Run it yourself:\n  ${manager} ${args.join(' ')}\n`,
    );
    return 1;
  }
  process.stderr.write(`metro is now ${newest}\n`);
  return 0;
}
