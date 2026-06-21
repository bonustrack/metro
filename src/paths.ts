import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { readJson } from './json-store.js';
import type { Line } from './lines.js';

export const STATE_DIR =
  process.env.METRO_STATE_DIR ?? join(homedir(), '.cache', 'metro');
mkdirSync(STATE_DIR, { recursive: true });

export const CONFIG_DIR =
  process.env.METRO_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'metro');
export const CONFIG_ENV_FILE = join(CONFIG_DIR, '.env');

export const TRAINS_ENV_FILE = join(homedir(), '.metro', '.env');

export const envSources = (): readonly { label: string; path: string }[] => [
  { label: 'cwd/.env', path: join(process.cwd(), '.env') },
  { label: '~/.metro/.env', path: TRAINS_ENV_FILE },
  { label: '$CONFIG/.env', path: CONFIG_ENV_FILE },
];

const LINE_RE = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/;
const QUOTED_RE = /^(['"])(.*)\1$/;

export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) out[m[1]] = m[2].replace(QUOTED_RE, '$2');
  }
  return out;
}

export function loadMetroEnv(): void {
  for (const { path } of envSources()) {
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

interface Entry {
  createdAt: string;
  lastSeenAt?: string;
  name?: string;
}
type Cache = Record<string, Entry>;

const cacheFile = join(STATE_DIR, 'lines.json');
const FLUSH_DELAY_MS = 5_000;
let cache: Cache | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function readCache(): Cache {
  if (cache) return cache;
  if (!existsSync(cacheFile)) return (cache = {});
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache;
  } catch (err) {
    log.warn(
      { err: errMsg(err), path: cacheFile },
      'lines cache read failed; treating as empty',
    );
    cache = {};
  }
  return cache;
}

function flush(): void {
  if (!dirty || !cache) return;
  try {
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    dirty = false;
  } catch (err) {
    log.warn({ err: errMsg(err), path: cacheFile }, 'lines cache write failed');
  }
}
process.on('exit', flush);

export function noteSeen(line: Line, name?: string): void {
  const c = readCache();
  const entry = (c[line] ??= { createdAt: new Date().toISOString() });
  entry.lastSeenAt = new Date().toISOString();
  if (name && entry.name !== name) entry.name = name;
  dirty = true;
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DELAY_MS);
}

export const listLines = (): { line: Line; entry: Entry }[] =>
  Object.entries(readCache()).map(([line, entry]) => ({
    line: line as Line,
    entry,
  }));

const botIdsFile = join(STATE_DIR, 'bot-ids.json');
export const readBotIds = (): Record<string, string> =>
  readJson<Record<string, string>>(botIdsFile, {});
