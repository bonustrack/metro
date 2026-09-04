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

export interface UpdateCheck {
  current: string;
  latest: string;
  newer: boolean;
}

export const checkReport = (current: string, latest: string): UpdateCheck => ({
  current,
  latest,
  newer: latest !== '' && isNewer(latest, current),
});

export async function updateCheck(): Promise<UpdateCheck> {
  return checkReport(currentVersion(), await publishedVersion());
}

export async function update(argv: string[] = []): Promise<number> {
  if (argv.includes('--check')) {
    process.stdout.write(`${JSON.stringify(await updateCheck())}\n`);
    return 0;
  }
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
