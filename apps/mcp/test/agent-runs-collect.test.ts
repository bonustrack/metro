import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRuns, ownerAlive } from '../src/runs/collect.ts';
import { runLabel } from '../src/runs/label.ts';
import { summarizeTranscript } from '../src/runs/transcript.ts';
import { changedRuns, nextCursor, runPayload } from '../src/runs/push.ts';

const SECRET_PROMPT =
  'Rotate the acme-corp production key and file it in the private repo';

let root: string;
let projects: string;
let workspaces: string;
let subagents: string;

const user = (text: string, ts: string): string =>
  JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: text },
  });

const assistant = (
  id: string,
  ts: string,
  content: unknown[],
  usage: Record<string, number>,
): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, role: 'assistant', content, usage },
  });

const USAGE = {
  input_tokens: 3,
  output_tokens: 120,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 900,
};

function writeRun(runId: string, lines: string[], description: string): void {
  writeFileSync(join(subagents, `agent-${runId}.jsonl`), `${lines.join('\n')}\n`);
  writeFileSync(
    join(subagents, `agent-${runId}.meta.json`),
    JSON.stringify({ agentType: 'worker', description, spawnDepth: 1 }),
  );
}

function writeWorkspace(runId: string, pid: number, startedAt: string): void {
  const dir = join(workspaces, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.agent-meta.json'),
    JSON.stringify({
      agent_id: runId,
      agent_type: 'worker',
      owner_pid: pid,
      started_at: startedAt,
    }),
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-runs-'));
  projects = join(root, 'projects');
  workspaces = join(root, 'agents');
  subagents = join(projects, '-root', 'session-1', 'subagents');
  mkdirSync(subagents, { recursive: true });
  mkdirSync(workspaces, { recursive: true });

  writeRun(
    'adone1',
    [
      user(SECRET_PROMPT, '2026-08-14T04:00:00.000Z'),
      assistant(
        'msg_1',
        '2026-08-14T04:00:10.000Z',
        [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        USAGE,
      ),
      user('tool result', '2026-08-14T04:00:11.000Z'),
      assistant('msg_2', '2026-08-14T04:01:00.000Z', [{ type: 'text', text: 'done' }], USAGE),
      assistant(
        'msg_2',
        '2026-08-14T04:01:02.000Z',
        [{ type: 'text', text: 'done, in full' }],
        { ...USAGE, output_tokens: 380 },
      ),
    ],
    'Rotate the acme key',
  );

  writeRun(
    'alost1',
    [
      user(SECRET_PROMPT, '2026-08-14T04:10:00.000Z'),
      assistant(
        'msg_3',
        '2026-08-14T04:10:30.000Z',
        [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 900' } }],
        USAGE,
      ),
    ],
    'Killed halfway',
  );

  writeRun(
    'arun01',
    [
      user(SECRET_PROMPT, '2026-08-14T04:20:00.000Z'),
      assistant('msg_4', '2026-08-14T04:20:30.000Z', [{ type: 'thinking' }], USAGE),
    ],
    'Still going',
  );
  writeWorkspace('arun01', process.pid, '2026-08-14T04:20:00.000Z');
  writeWorkspace('afresh', process.pid, '2026-08-14T04:30:00.000Z');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const byId = (id: string): ReturnType<typeof collectRuns>[number] => {
  const run = collectRuns({ projects, workspaces }).find((r) => r.runId === id);
  if (run === undefined) throw new Error(`no run ${id}`);
  return run;
};

describe('summarizing a subagent transcript', () => {
  test('a streamed message is one turn, counted once at its final size', () => {
    const run = byId('adone1');
    expect(run.turns).toBe(2);
    expect(run.outputTokens).toBe(120 + 380);
    expect(run.cacheReadTokens).toBe(8000);
  });

  test('the run is bounded by the first and last line of the transcript', () => {
    const run = byId('adone1');
    expect(run.startedAt).toBe('2026-08-14T04:00:00.000Z');
    expect(run.endedAt).toBe('2026-08-14T04:01:02.000Z');
  });

  test('an empty transcript summarizes to nothing rather than throwing', () => {
    expect(summarizeTranscript([])).toEqual({
      startedAt: null,
      endedAt: null,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      finished: false,
    });
  });

  test('a line that is not JSON is skipped, not fatal', () => {
    const summary = summarizeTranscript([
      '{not json at all',
      assistant('msg_x', '2026-08-14T04:00:00.000Z', [{ type: 'text', text: 'hi' }], USAGE),
    ]);
    expect(summary.turns).toBe(1);
    expect(summary.finished).toBe(true);
  });
});

describe('the state of a run', () => {
  test('a transcript ending in a final answer is done', () => {
    expect(byId('adone1').state).toBe('done');
  });

  test('a transcript ending mid tool call with no live workspace is lost', () => {
    const run = byId('alost1');
    expect(run.state).toBe('lost');
    expect(run.endedAt).toBe('2026-08-14T04:10:30.000Z');
  });

  test('a live workspace with a live owner is running, and carries no end', () => {
    const run = byId('arun01');
    expect(run.state).toBe('running');
    expect(run.endedAt).toBeNull();
  });

  test('a workspace with no transcript yet still reports the run', () => {
    const run = byId('afresh');
    expect(run.state).toBe('running');
    expect(run.startedAt).toBe('2026-08-14T04:30:00.000Z');
    expect(run.turns).toBe(0);
  });

  test('an owner process that is gone is not alive', () => {
    expect(ownerAlive({ owner_pid: process.pid })).toBe(true);
    expect(ownerAlive({ owner_pid: process.pid, owner_pid_start: '1' })).toBe(false);
    expect(ownerAlive({ owner_pid: 0 })).toBe(false);
    expect(ownerAlive({})).toBe(false);
  });
});

describe('what leaves the box', () => {
  test('the payload carries counts and a label, and never the task prompt', () => {
    for (const run of collectRuns({ projects, workspaces })) {
      const wire = JSON.stringify(runPayload(run));
      expect(wire).not.toContain('acme-corp');
      expect(wire).not.toContain(SECRET_PROMPT);
    }
  });

  test('the payload has exactly the agreed fields, nothing else', () => {
    expect(Object.keys(runPayload(byId('adone1'))).sort()).toEqual([
      'cache_read_tokens',
      'cache_write_tokens',
      'ended_at',
      'id',
      'input_tokens',
      'label',
      'output_tokens',
      'started_at',
      'state',
      'turns',
      'type',
    ]);
  });

  test('the label is the short description, flattened and truncated', () => {
    expect(runLabel('  Rotate  the\nacme key ')).toBe('Rotate the acme key');
    expect(runLabel('x'.repeat(300))?.length).toBe(80);
    expect(runLabel('')).toBeNull();
    expect(runLabel(undefined)).toBeNull();
  });
});

describe('only what changed is pushed', () => {
  test('a run is sent once until its transcript or state moves', () => {
    const runs = collectRuns({ projects, workspaces });
    expect(changedRuns(runs, {})).toHaveLength(runs.length);
    const cursor = nextCursor(runs, new Set(runs.map((r) => r.runId)));
    expect(changedRuns(runs, cursor)).toEqual([]);
    const moved = { ...cursor, adone1: 'stale' };
    expect(changedRuns(runs, moved).map((r) => r.runId)).toEqual(['adone1']);
  });
});
