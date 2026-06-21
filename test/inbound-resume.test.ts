/**
 * Regression test for the channel-reconnect-on-restart fix: the MCP inbound
 * relay must resume the history tail from a persisted byte cursor after a
 * daemon restart, so events written across the restart window are delivered
 * (not silently dropped at a fresh EOF seek).
 *
 * Exercises the resume machinery directly (drainTail + readCursor/writeCursor)
 * the same way src/mcp/index.ts startInbound() wires it. STATE_DIR is fixed by
 * the test runner (METRO_STATE_DIR); each test resets history.jsonl + cursor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../src/paths.ts';
import {
  drainTail,
  historySize,
  readCursor,
  writeCursor,
  type TailOpts,
} from '../src/broker/history-stream.ts';

interface Entry {
  id: string;
  ts: string;
  kind: string;
  station: string;
  line: string;
  from: string;
  to: string;
  text: string;
}

const HISTORY = join(STATE_DIR, 'history.jsonl');
const CURSOR = join(STATE_DIR, 'cursors', '_inbound_mcp');
const KEY = '_inbound_mcp';
const opts: TailOpts = { mode: 'all', self: null };

const mkEntry = (id: string, text: string): Entry => ({
  id,
  ts: '2026-06-21T00:00:00.000Z',
  kind: 'inbound',
  station: 'discord',
  line: 'metro://discord/1',
  from: 'metro://discord/user/x',
  to: 'metro://discord/1',
  text,
});

const append = (e: Entry): void => {
  appendFileSync(HISTORY, JSON.stringify(e) + '\n');
};

const drain = (start: number): { seen: string[]; offset: number } => {
  const seen: string[] = [];
  const offset = drainTail(start, opts, (e) => {
    seen.push((e as unknown as Entry).id);
  });
  return { seen, offset };
};

/** Mirrors startInbound()'s resume-or-EOF seed decision. */
const resumeStart = (): number => {
  const saved = readCursor(KEY);
  const size = historySize();
  return saved > 0 && saved <= size ? saved : size;
};

beforeEach(() => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(HISTORY, '');
  rmSync(CURSOR, { force: true });
});
afterEach(() => {
  writeFileSync(HISTORY, '');
  rmSync(CURSOR, { force: true });
});

describe('inbound tail resume after restart', () => {
  test('fresh boot seeds at EOF (no backlog replay)', () => {
    append(mkEntry('msg_old', 'pre-boot'));
    const { seen, offset } = drain(historySize());
    writeCursor(KEY, offset);
    expect(seen).toEqual([]);
    expect(readCursor(KEY)).toBe(historySize());
  });

  test('restart resumes from persisted cursor and delivers the gap', () => {
    /** First boot: seed at EOF, persist cursor. */
    let r = drain(historySize());
    writeCursor(KEY, r.offset);
    expect(r.seen).toEqual([]);

    /** A live event is delivered and the cursor advances past it. */
    append(mkEntry('msg_live', 'while-up'));
    r = drain(readCursor(KEY));
    writeCursor(KEY, r.offset);
    expect(r.seen).toEqual(['msg_live']);

    /** Daemon goes DOWN. Two events land in the gap. */
    append(mkEntry('msg_gap1', 'down-1'));
    append(mkEntry('msg_gap2', 'down-2'));

    /** Restart: resume from the persisted cursor (NOT a fresh EOF). */
    r = drain(resumeStart());
    writeCursor(KEY, r.offset);

    /** Both gap events recovered; the already-delivered one is not replayed. */
    expect(r.seen).toEqual(['msg_gap1', 'msg_gap2']);
    expect(readCursor(KEY)).toBe(historySize());
  });

  test('corrupt / out-of-range cursor falls back to EOF (no double-replay)', () => {
    append(mkEntry('msg_a', 'a'));
    append(mkEntry('msg_b', 'b'));
    writeCursor(KEY, historySize() + 9_999);
    const { seen } = drain(resumeStart());
    expect(seen).toEqual([]);
  });
});
