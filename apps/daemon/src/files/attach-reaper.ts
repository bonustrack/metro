import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachDir,
  resolveCachedAttachment,
} from '@metro-labs/core/stations/attachments';
import { errMsg, log } from '@metro-labs/core/log';

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_MB = 2048;
const PART_TTL_MS = 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const SIDECARS = ['.owner', '.grant'] as const;

export interface AttachSweepOptions {
  dir?: string;
  now?: number;
  ttlMs?: number;
  maxBytes?: number;
}

export interface AttachSweepResult {
  expired: number;
  capped: number;
  orphans: number;
  parts: number;
  freedBytes: number;
}

interface Entry {
  name: string;
  mtime: number;
  size: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const attachTtlMs = (): number =>
  positive(process.env.METRO_ATTACH_TTL_DAYS, DEFAULT_TTL_DAYS) * DAY_MS;

export const attachMaxBytes = (): number =>
  positive(process.env.METRO_ATTACH_MAX_MB, DEFAULT_MAX_MB) * MB;

const cacheShaped = (name: string): boolean =>
  resolveCachedAttachment(name) !== null;

function stripSuffix(name: string, suffixes: readonly string[]): string | undefined {
  const suffix = suffixes.find((s) => name.endsWith(s));
  if (suffix === undefined) return undefined;
  const base = name.slice(0, -suffix.length);
  return cacheShaped(base) ? base : undefined;
}

function listEntries(dir: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) entries.push({ name, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      continue;
    }
  }
  return entries;
}

function removeEntry(dir: string, name: string): void {
  rmSync(join(dir, name), { force: true });
}

function removeWithSidecars(dir: string, name: string): void {
  removeEntry(dir, name);
  for (const suffix of SIDECARS) removeEntry(dir, `${name}${suffix}`);
}

interface Sweep {
  dir: string;
  now: number;
  entries: Entry[];
  result: AttachSweepResult;
}

function sweepParts(sweep: Sweep): Set<string> {
  const fresh = new Set<string>();
  for (const entry of sweep.entries) {
    const base = stripSuffix(entry.name, ['.part']);
    if (base === undefined) continue;
    if (sweep.now - entry.mtime <= PART_TTL_MS) {
      fresh.add(base);
      continue;
    }
    removeEntry(sweep.dir, entry.name);
    sweep.result.parts += 1;
    sweep.result.freedBytes += entry.size;
  }
  return fresh;
}

function sweepExpired(sweep: Sweep, ttlMs: number): Entry[] {
  const kept: Entry[] = [];
  for (const entry of sweep.entries) {
    if (!cacheShaped(entry.name)) continue;
    if (sweep.now - entry.mtime <= ttlMs) {
      kept.push(entry);
      continue;
    }
    removeWithSidecars(sweep.dir, entry.name);
    sweep.result.expired += 1;
    sweep.result.freedBytes += entry.size;
  }
  return kept;
}

function sweepOrphans(sweep: Sweep, busy: Set<string>): void {
  const present = new Set(sweep.entries.map((e) => e.name));
  for (const entry of sweep.entries) {
    const base = stripSuffix(entry.name, SIDECARS);
    if (base === undefined || present.has(base) || busy.has(base)) continue;
    removeEntry(sweep.dir, entry.name);
    sweep.result.orphans += 1;
  }
}

function capSize(sweep: Sweep, kept: Entry[], maxBytes: number): void {
  let total = kept.reduce((sum, e) => sum + e.size, 0);
  for (const entry of [...kept].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) return;
    removeWithSidecars(sweep.dir, entry.name);
    total -= entry.size;
    sweep.result.capped += 1;
    sweep.result.freedBytes += entry.size;
  }
}

export function sweepAttachments(options: AttachSweepOptions = {}): AttachSweepResult {
  const dir = options.dir ?? attachDir();
  const sweep: Sweep = {
    dir,
    now: options.now ?? Date.now(),
    entries: listEntries(dir),
    result: { expired: 0, capped: 0, orphans: 0, parts: 0, freedBytes: 0 },
  };
  const busy = sweepParts(sweep);
  const kept = sweepExpired(sweep, options.ttlMs ?? attachTtlMs());
  sweepOrphans(sweep, busy);
  capSize(sweep, kept, options.maxBytes ?? attachMaxBytes());
  return sweep.result;
}

export function startAttachReaper(): void {
  const run = (): void => {
    try {
      const swept = sweepAttachments();
      if (swept.expired + swept.capped + swept.orphans + swept.parts > 0) {
        log.info(swept, 'attachments: reaped the cache');
      }
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'attachments: sweep failed');
    }
  };
  run();
  setInterval(run, SWEEP_MS).unref?.();
}
