/**
 * Inbound dedup + per-line sequence numbers (Metro protocol improvement #6).
 *
 * Covers: duplicate replay dropped, no-messageId never deduped, seq monotonic
 * per line, outbound never deduped, and the makeEmit integration. Dedup + seq
 * are now live-from-boot (no persisted history.jsonl seed) — there is no
 * cross-restart warm-start to test.
 */

import { describe, expect, test } from 'bun:test';
import { makeDedupSeq } from '../src/dispatcher/server.ts';
import { makeEmit } from '../src/dispatcher/server.ts';
import type { MetroEvent } from '../src/events.ts';
import { Line } from '../src/lines.ts';

const inbound = (overrides: Partial<MetroEvent> = {}): MetroEvent => ({
  id: 'msg_x', ts: '2026-06-10T00:00:00.000Z', station: 'discord',
  line: 'metro://discord/1' as Line,
  from: 'metro://discord/user/9' as Line,
  to: 'metro://discord/1' as Line,
  text: 'hello', messageId: 'plat-1',
  ...overrides,
});

/** Capture every JSON line `makeEmit` writes to stdout for a batch of entries. */
function emitAll(entries: MetroEvent[]): MetroEvent[] {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  // @ts-expect-error narrow override for the test
  process.stdout.write = (chunk: string) => { lines.push(chunk); return true; };
  try {
    const emit = makeEmit(makeDedupSeq());
    for (const e of entries) emit(e);
  } finally {
    process.stdout.write = orig;
  }
  return lines.map(l => JSON.parse(l.trim()) as MetroEvent);
}

describe('dedup-seq tracker', () => {
  test('duplicate replay (same platform id twice) -> one entry, seq from 1', () => {
    const t = makeDedupSeq();
    const a = t.admit(inbound({ messageId: 'p1' }));
    const b = t.admit(inbound({ messageId: 'p1' }));
    expect(a).toBe(1);
    expect(b).toBeNull();
  });

  test('no messageId is never deduped (each gets its own seq)', () => {
    const t = makeDedupSeq();
    const a = t.admit(inbound({ messageId: undefined, text: 'x' }));
    const b = t.admit(inbound({ messageId: undefined, text: 'x' }));
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  test('outbound/local entries are never deduped even with a repeated id', () => {
    const t = makeDedupSeq();
    const local = inbound({ from: 'metro://claude/main' as Line, messageId: 'same' });
    expect(t.admit(local)).toBe(1);
    expect(t.admit(local)).toBe(2);
  });

  test('seq is monotonic per line and independent across lines', () => {
    const t = makeDedupSeq();
    const A = 'metro://discord/A' as Line;
    const B = 'metro://discord/B' as Line;
    expect(t.admit(inbound({ line: A, messageId: 'a1' }))).toBe(1);
    expect(t.admit(inbound({ line: B, messageId: 'b1' }))).toBe(1);
    expect(t.admit(inbound({ line: A, messageId: 'a2' }))).toBe(2);
    expect(t.admit(inbound({ line: B, messageId: 'b2' }))).toBe(2);
    expect(t.admit(inbound({ line: A, messageId: 'a3' }))).toBe(3);
  });

  test('fresh tracker (no persisted seed) starts the per-line counter at 1', () => {
    const t = makeDedupSeq();
    expect(t.admit(inbound({ messageId: 'p1' }))).toBe(1);
  });
});

describe('makeEmit integration', () => {
  test('emit stamps seq on the wire and drops a duplicate', () => {
    const out = emitAll([
      inbound({ messageId: 'p1', id: 'msg_a' }),
      inbound({ messageId: 'p1', id: 'msg_b' }), // duplicate -> dropped
      inbound({ messageId: 'p2', id: 'msg_c' }),
    ]);
    expect(out.map(e => e.id)).toEqual(['msg_a', 'msg_c']);
    expect(out.map(e => e.seq)).toEqual([1, 2]);
  });

  test('legacy parity: entry without messageId still flows and gets a seq', () => {
    const out = emitAll([inbound({ messageId: undefined, id: 'msg_z' })]);
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(1);
    expect(out[0].display).toContain('hello');
  });
});
