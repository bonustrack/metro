import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SYSTEM_SLICE = '/sys/fs/cgroup/system.slice';
const SESSION_SCOPE = /^metro-claude-\d+\.scope$/;

type Run = (file: string, args: string[]) => boolean;

const quiet: Run = (file, args) => spawnSync(file, args, { stdio: 'ignore' }).status === 0;

const softLimit = (dir: string): string | null => {
  const path = join(dir, 'memory.high');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
};

export function liftSessionSoftLimits(run: Run = quiet, slice: string = SYSTEM_SLICE): string[] {
  if (!existsSync(slice)) return [];
  const held = readdirSync(slice).filter((name) => SESSION_SCOPE.test(name) && ![null, 'max'].includes(softLimit(join(slice, name))));
  return held.map((scope) =>
    run('systemctl', ['set-property', '--runtime', scope, 'MemoryHigh=infinity'])
      ? `${scope}: its soft memory limit is lifted, so only the hard limit applies`
      : `${scope}: its soft memory limit could not be lifted; it goes when the session starts again`,
  );
}
