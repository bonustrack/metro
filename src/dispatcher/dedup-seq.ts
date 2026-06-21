import { Line } from '../lines.js';
import { log } from '../log.js';
import type { MetroEvent } from '../events.js';

const LRU_CAP = 2_000;

function dedupKey(
  e: Pick<MetroEvent, 'station' | 'line' | 'messageId'>,
): string | null {
  if (!e.messageId) return null;
  return `${e.station} ${e.line} ${e.messageId}`;
}

export interface DedupSeq {
  admit(entry: MetroEvent): number | null;
}

export function makeDedupSeq(): DedupSeq {
  const seen = new Map<string, true>();
  const seqByLine = new Map<string, number>();

  log.info('dedup+seq: live-from-boot (no persisted seed)');

  const isInbound = (e: MetroEvent): boolean => !Line.isLocal(e.from);

  return {
    admit(entry: MetroEvent): number | null {
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
