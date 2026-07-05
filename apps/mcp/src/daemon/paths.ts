import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';

export const STATE_DIR =
  process.env.METRO_STATE_DIR ?? join(homedir(), '.cache', 'metro');
mkdirSync(STATE_DIR, { recursive: true });

export const CONFIG_DIR =
  process.env.METRO_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'metro');
export const CONFIG_ENV_FILE = join(CONFIG_DIR, '.env');

export const TRAINS_ENV_FILE = join(homedir(), '.metro', '.env');

export const envSources = (): readonly string[] => [
  join(process.cwd(), '.env'),
  TRAINS_ENV_FILE,
  CONFIG_ENV_FILE,
];

const LINE_RE = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/;
const QUOTED_RE = /^(['"])(.*)\1$/;

export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = LINE_RE.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined)
      out[m[1]] = m[2].replace(QUOTED_RE, '$2');
  }
  return out;
}

export function loadMetroEnv(): void {
  for (const path of envSources()) {
    for (const [k, v] of Object.entries(readDotenv(path))) {
      process.env[k] ??= v;
    }
  }
}

export function acquireLock(lockFile: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on('exit', () => {
        try {
          if (readFileSync(lockFile, 'utf8').trim() === String(process.pid))
            unlinkSync(lockFile);
        } catch {
        }
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let pid = NaN;
      try {
        pid = Number(readFileSync(lockFile, 'utf8').trim());
      } catch {
      }
      try {
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          log.info(
            { pid },
            'a healthy `metro` daemon is already running; exiting (no second dispatcher)',
          );
          process.exit(0);
        }
      } catch {
      }
      try {
        unlinkSync(lockFile);
      } catch {
      }
    }
  }
  throw new Error(
    `metro: could not acquire dispatcher lock (${lockFile}) after retries`,
  );
}
