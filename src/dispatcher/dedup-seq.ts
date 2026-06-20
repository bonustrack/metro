import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { Line } from '../lines.js';
import { log } from '../log.js';
import type { HistoryEntry } from '../history.js';

const SEED_TAIL_LINES = 2_000;
const LRU_CAP = 2_000;

function dedupKey(
  e: Pick<HistoryEntry, 'station' | 'line' | 'messageId'>,
): string | null {
  if (!e.messageId) return null;
  return `${e.station} ${e.line} ${e.messageId}`;
}

function readTailLines(path: string, maxLines: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const chunkSize = 64 * 1024;
    let pos = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    while (pos > 0 && newlines <= maxLines) {
      const readLen = Math.min(chunkSize, pos);
      pos -= readLen;
      const chunk = Buffer.alloc(readLen);
      readSync(fd, chunk, 0, readLen, pos);
      buf = Buffer.concat([chunk, buf]);
      for (const b of chunk) if (b === 0x0a) newlines++;
    }
    const lines = buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim());
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

export interface DedupSeq {
  admit(entry: HistoryEntry): number | null;
}

export function makeDedupSeq(historyPath: string): DedupSeq {
  const seen = new Map<string, true>();
  const seqByLine = new Map<string, number>();

  let seeded = 0;
  for (const raw of readTailLines(historyPath, SEED_TAIL_LINES)) {
    let e: HistoryEntry;
    try {
      e = JSON.parse(raw) as HistoryEntry;
    } catch {
      continue;
    }
    seeded++;
    const k = dedupKey(e);
    if (k) {
      seen.delete(k);
      seen.set(k, true);
      while (seen.size > LRU_CAP) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
    }
    if (typeof e.seq === 'number' && e.line) {
      const prev = seqByLine.get(e.line) ?? 0;
      if (e.seq > prev) seqByLine.set(e.line, e.seq);
    }
  }
  log.info(
    { seeded, dedupKeys: seen.size, lines: seqByLine.size },
    'dedup+seq warm-start',
  );

  const isInbound = (e: HistoryEntry): boolean => !Line.isLocal(e.from);

  return {
    admit(entry: HistoryEntry): number | null {
      const key = dedupKey(entry);
      if (key && isInbound(entry)) {
        if (seen.has(key)) {
          log.debug(
            {
              station: entry.station,
              line: entry.line,
              messageId: entry.messageId,
            },
            'dedup: dropped duplicate inbound message',
          );
          return null;
        }
        seen.set(key, true);
        while (seen.size > LRU_CAP) {
          const oldest = seen.keys().next();
          if (oldest.done) break;
          seen.delete(oldest.value);
        }
      }
      const next = (seqByLine.get(entry.line) ?? 0) + 1;
      seqByLine.set(entry.line, next);
      return next;
    },
  };
}
