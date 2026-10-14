import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = fileURLToPath(new URL('../../../../packages/cli', import.meta.url));
const HOOKS = 'hooks';
const SKILLS = 'skills';
export const GUARD_HOOK = 'guard.mjs';
export const SESSION_START_HOOK = 'session-start.mjs';
const UNSAFE_PATH = /["$`\\\n]/;

export function cliPackageDir(env: NodeJS.ProcessEnv = process.env): string {
  const bin = env.METRO_CLI_BIN?.trim() ?? '';
  if (bin === '') return CHECKOUT;
  try {
    return dirname(dirname(realpathSync(bin)));
  } catch {
    return CHECKOUT;
  }
}

export const skillsDir = (cli: string): string => join(cli, SKILLS);

export function hooksDir(cli: string): string | null {
  const dir = join(cli, HOOKS);
  if (UNSAFE_PATH.test(dir)) return null;
  return existsSync(join(dir, GUARD_HOOK)) && existsSync(join(dir, SESSION_START_HOOK)) ? dir : null;
}
