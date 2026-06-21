import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '../log.js';
import { STATE_DIR } from '../paths.js';
import { Line } from '../lines.js';
import type { HistoryEntry } from '../history.js';
import { HISTORY_FILE, readClaims, type ClaimsMap } from './claims.js';

const CURSORS_DIR = join(STATE_DIR, 'cursors');

export type Mode = 'all' | 'mine-or-unclaimed' | 'mine-only' | 'unclaimed';

export function userSlug(uri: Line): string {
  return uri.replace(/^metro:\/+/, '').replace(/[^A-Za-z0-9_.-]/g, '-');
}

export function cursorKey(
  mode: Mode,
  self: Line | null,
  opts: { includeWebhooks?: boolean } = {},
): string | null {
  if (mode === 'all') return '_all';
  if (mode === 'unclaimed') return '_unclaimed';
  if (!self) return null;
  const base = userSlug(self);
  const suffix = mode === 'mine-only' ? '--strict' : '';
  const webhooks = opts.includeWebhooks ? '--with-webhooks' : '';
  return `${base}${suffix}${webhooks}`;
}

const cursorPath = (key: string): string => join(CURSORS_DIR, key);

export function readCursor(key: string): number {
  const p = cursorPath(key);
  if (!existsSync(p)) return 0;
  const n = Number(readFileSync(p, 'utf8').trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writeCursor(key: string, offset: number): void {
  mkdirSync(CURSORS_DIR, { recursive: true });
  const p = cursorPath(key);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, String(offset));
  renameSync(tmp, p);
}

export function historySize(): number {
  if (!existsSync(HISTORY_FILE)) return 0;
  try {
    return readFileSync(HISTORY_FILE).length;
  } catch {
    return 0;
  }
}

function* readEntriesFrom(
  offset: number,
): Generator<{ entry: HistoryEntry; offset: number }> {
  if (!existsSync(HISTORY_FILE)) return;
  const fd = openSync(HISTORY_FILE, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let pos = offset;
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) break;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      pos += n;
      let nl;
      while ((nl = pending.indexOf(0x0a)) !== -1) {
        const raw = pending.subarray(0, nl).toString('utf8').trim();
        pending = pending.subarray(nl + 1);
        if (!raw) continue;
        const offsetAfter = pos - pending.length;
        try {
          const entry = JSON.parse(raw) as HistoryEntry;
          yield { entry, offset: offsetAfter };
        } catch (err) {
          log.warn(
            { err: errMsg(err), offset: offsetAfter },
            'broker: skipped malformed history line',
          );
          yield { entry: null as unknown as HistoryEntry, offset: offsetAfter };
        }
      }
    }
  } finally {
    closeSync(fd);
  }
}

export function passesMode(
  event: HistoryEntry,
  mode: Mode,
  self: Line | null,
  claims: ClaimsMap,
  opts: { includeWebhooks?: boolean } = {},
): boolean {
  if (self && event.to === self) return true;
  if (mode === 'all') return true;
  const isWebhook = event.station === 'webhook';
  if (mode === 'unclaimed') return !claims[event.line];
  if (isWebhook && !opts.includeWebhooks) return false;
  const owner = claims[event.line];
  if (mode === 'mine-only') return owner === self;
  return !owner || owner === self;
}

export interface TailOpts {
  mode: Mode;
  self: Line | null;
  chatFilter?: string;
  stationFilter?: string;
  includeWebhooks?: boolean;
  excludeFrom?: string[];
}

function tailIncludes(
  entry: HistoryEntry,
  opts: TailOpts,
  claims: ClaimsMap,
): boolean {
  if (opts.chatFilter && entry.line !== opts.chatFilter) return false;
  if (opts.stationFilter && entry.station !== opts.stationFilter) return false;
  if (opts.excludeFrom?.includes(entry.from)) return false;
  return passesMode(entry, opts.mode, opts.self, claims, {
    includeWebhooks: opts.includeWebhooks,
  });
}

export function drainTail(
  offset: number,
  opts: TailOpts,
  onEntry: (e: HistoryEntry, offsetAfter: number) => unknown,
): number {
  const claims = readClaims();
  for (const { entry, offset: next } of readEntriesFrom(offset)) {
    offset = next;
    if (!entry) continue;
    if (!tailIncludes(entry, opts, claims)) continue;
    if (onEntry(entry, offset) === true) return offset;
  }
  return offset;
}

export function followTail(
  startOffset: number,
  opts: TailOpts,
  onEntry: (e: HistoryEntry, offsetAfter: number) => unknown,
  pollMs: number,
): () => void {
  let offset = startOffset;
  const tick = (): void => {
    offset = drainTail(offset, opts, onEntry);
  };
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(HISTORY_FILE, () => {
      tick();
    });
  } catch {
  }
  const poll = setInterval(tick, pollMs);
  return () => {
    clearInterval(poll);
    if (watcher) {
      try {
        watcher.close();
      } catch {
      }
    }
  };
}
