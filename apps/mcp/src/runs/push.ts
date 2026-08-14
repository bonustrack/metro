import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunState } from '../db/schema.js';
import { runLabel } from './label.js';
import type { CollectedRun } from './collect.js';

export interface RunPayload {
  id: string;
  type: string | null;
  label: string | null;
  state: RunState;
  started_at: string;
  ended_at: string | null;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type Cursor = Record<string, string>;

export const MAX_BATCH = 200;
const ERROR_PREVIEW = 200;

export function runPayload(run: CollectedRun): RunPayload {
  return {
    id: run.runId,
    type: run.agentType,
    label: runLabel(run.label),
    state: run.state,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    turns: run.turns,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    cache_read_tokens: run.cacheReadTokens,
    cache_write_tokens: run.cacheWriteTokens,
  };
}

export function changedRuns(runs: CollectedRun[], cursor: Cursor): CollectedRun[] {
  return runs.filter((run) => cursor[run.runId] !== run.fingerprint);
}

export function nextCursor(runs: CollectedRun[], pushed: Set<string>): Cursor {
  const cursor: Cursor = {};
  for (const run of runs)
    if (pushed.has(run.runId)) cursor[run.runId] = run.fingerprint;
  return cursor;
}

export function batches(runs: CollectedRun[], size = MAX_BATCH): CollectedRun[][] {
  const out: CollectedRun[][] = [];
  for (let i = 0; i < runs.length; i += size) out.push(runs.slice(i, i + size));
  return out;
}

export function cursorPath(): string {
  const dir =
    process.env.METRO_STATE_DIR ?? join(homedir(), '.cache', 'metro');
  return process.env.METRO_RUNS_CURSOR ?? join(dir, 'agent-runs-cursor.json');
}

export function readCursor(path: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return {};
    const cursor: Cursor = {};
    for (const [id, mark] of Object.entries(parsed))
      if (typeof mark === 'string') cursor[id] = mark;
    return cursor;
  } catch {
    return {};
  }
}

export function writeCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor), { mode: 0o600 });
}

export interface PushTarget {
  base: string;
  key: string;
}

export async function postRuns(
  target: PushTarget,
  runs: CollectedRun[],
): Promise<number> {
  const res = await fetch(`${target.base}/api/agent-runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ runs: runs.map(runPayload) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `metro answered ${res.status}: ${detail.slice(0, ERROR_PREVIEW)}`,
    );
  }
  return runs.length;
}
