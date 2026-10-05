import { describe, expect, test } from 'bun:test';
import { toClaudeSession } from '../src/api/claude-box.js';
import { activityView, sessionPollMs } from '../src/api/runner-activity.js';

const now = 1_800_000_000_000;
const task = {
  id: 'worker-1', agent: 'Explore', kind: 'local_agent', status: 'running', background: true,
  startedAt: now - 60_000, updatedAt: now - 5_000, endedAt: null, lastTool: 'Read', toolUses: 3, durationMs: 45_000,
};
const mainTool = { id: 'tool-1', name: 'Agent', taskId: null, startedAt: now - 10_000 };
const workerTool = { id: 'tool-2', name: 'Bash', taskId: 'worker-1', startedAt: now - 5_000 };
const snapshot = {
  runner: 'sdk', pid: 123, phase: 'working', mainPhase: 'working', mainStartedAt: now - 20_000,
  updatedAt: now, activeTools: [mainTool, workerTool], tasks: [task],
};

function view(over: Record<string, unknown> = {}, at = now, session: Record<string, unknown> = {}): ReturnType<typeof activityView> {
  const status = toClaudeSession({ running: true, runner: 'sdk', activity: { ...snapshot, ...over }, ...session });
  if (status.activity === null) throw new Error('Activity fixture did not parse');
  return activityView(status, status.activity, at);
}

describe('main agent and worker activity', () => {
  test('main status stays independent of working subagents and tools are attributed by task id', () => {
    const active = view();
    expect(active.main).toBe('Main agent: working for 20 s');
    expect(active.tools).toBe('Main tools: Agent (10 s)');
    expect(active.workers[0]?.summary).toContain('Explore · running (1 min) · using Bash (5 s)');
    expect(active.workers[0]?.summary).toContain('last progress 5 s ago');
    expect(active.workers[0]?.details).toContain('Background: Yes');
    expect(active.workers[0]?.details).toContain('Tool uses: 3');
    expect(view({ mainPhase: 'idle', mainStartedAt: null }).main).toBe('Main agent: idle');
    expect(view({ mainPhase: 'approval' }).main).toBe('Main agent: waiting for approval for 20 s');
    expect(view({ mainPhase: 'compacting' }).main).toContain('compacting the conversation for 20 s');
    expect(view({ mainPhase: 'error' }).main).toBe('Main agent: error');
  });

  test('unassigned worker tools never appear as main tools and older snapshots stay compatible', () => {
    const unassigned = { id: 'tool-3', name: 'Grep', taskId: null, worker: true, startedAt: now - 3_000 };
    const activeTools = [{ ...mainTool, worker: false }, { ...workerTool, worker: true }, unassigned];
    const active = view({ activeTools });
    expect(active.tools).toBe('Main tools: Agent (10 s) · Unassigned worker tools: Grep (3 s)');
    expect(active.workers[0]?.summary).toContain('using Bash (5 s)');
    expect(view({ activeTools }, now + 40_000).tools).toBe('Main tools at the last report: Agent (10 s) · Unassigned worker tools at the last report: Grep (3 s)');
    expect(view({ activeTools: [unassigned] }).tools).toBe('Main tools: None reported · Unassigned worker tools: Grep (3 s)');
    expect(view().tools).toBe('Main tools: Agent (10 s)');
  });

  test('elapsed times advance while reports are fresh and freeze at updatedAt once stale', () => {
    expect(view({}, now + 10_000).main).toBe('Main agent: working for 30 s');
    const stale = view({}, now + 40_000);
    const later = view({}, now + 90_000);
    expect(stale.mode).toBe('stale');
    expect(stale.note).toContain('Stale status');
    expect(stale.note).toContain('Times stop at the last report');
    expect(stale.main).toBe('Main agent: working for 20 s at the last report');
    expect(later.main).toBe(stale.main);
    expect(later.tools).toBe(stale.tools);
    expect(stale.workers[0]?.summary).toContain('running (1 min) at the last report · was using Bash (5 s)');
    expect(later.workers[0]?.summary).toContain('running (1 min) at the last report · was using Bash (5 s)');
    expect(later.workers[0]?.summary).toContain('last progress 1 min 35 s ago');
  });

  test('stopped processes, stopped SDK reports and old reports while CLI runs are historical', () => {
    for (const session of [{ running: false }, { runner: 'cli' }]) {
      const past = view({}, now + 120_000, session);
      expect(past.mode).toBe('past');
      expect(past.note).toContain('History, not live');
      expect(past.main).toContain('20 s at the last report');
      expect(past.workers[0]?.summary).toContain('running (1 min) at the last report');
    }
    expect(view({}, now, { runner: 'cli' }).note).toContain('Claude Code runs now');
    const stopped = view({ phase: 'stopped', mainPhase: 'stopped' }, now + 120_000);
    expect(stopped.mode).toBe('past');
    expect(stopped.note).toContain('Agent SDK reported it stopped');
    expect(stopped.main).toBe('Main agent: stopped at the last report');
  });

  test('future reports are marked stale without claiming an old heartbeat', () => {
    const future = view({ updatedAt: now + 60_000 });
    expect(future.mode).toBe('stale');
    expect(future.note).toContain('report time is ahead of this device');
    expect(future.note).not.toContain('ago');
  });

  test('every task status is readable, with terminal duration and failure emphasis', () => {
    for (const state of ['completed', 'failed', 'stopped']) {
      const row = view({ tasks: [{ ...task, status: state, endedAt: now - 2_000 }] }).workers[0];
      expect(row?.summary).toContain(`${state} in 45 s`);
      expect(row?.summary).toContain('last tool Read · 3 tool uses · ended 2 s ago');
      expect(row?.danger).toBe(state === 'failed');
    }
    expect(view({ tasks: [{ ...task, status: 'paused' }] }).workers[0]?.summary).toContain('paused (1 min)');
    expect(view({ tasks: [{ ...task, status: 'pending' }] }).workers[0]?.summary).toContain('waiting to start (1 min)');
    expect(view({ tasks: [{ ...task, status: 'unknown', startedAt: 0 }] }).workers[0]?.summary).toContain('state unknown');
    const fallback = view({ tasks: [{ ...task, status: 'completed', durationMs: 0, endedAt: now - 2_000 }] });
    expect(fallback.workers[0]?.summary).toContain('completed in 58 s');
  });

  test('missing timestamps do not imply a runtime since the epoch', () => {
    const missing = view({ mainStartedAt: null, activeTools: [{ ...mainTool, startedAt: 0 }], tasks: [{ id: 'worker-1', status: 'unknown' }] });
    expect(missing.main).toBe('Main agent: working');
    expect(missing.tools).toBe('Main tools: Agent');
    expect(missing.workers[0]?.summary).toContain('last progress not reported');
    expect(missing.workers[0]?.details).toContain('Elapsed: Not reported');
    expect(missing.workers[0]?.details).toContain('Started: Not reported');
  });

  test('old SDK reports have safe empty arrays and legacy tool names still show', () => {
    const old = view({ mainPhase: undefined, mainStartedAt: undefined, activeTools: undefined, tasks: undefined, events: undefined, tools: ['Read'] });
    expect(old.main).toBe('Main agent: working');
    expect(old.tools).toBe('Tools in use: Read');
    expect(old.workers).toEqual([]);
    expect(old.events).toEqual([]);
    expect(view({ activeTools: [] }).tools).toBe('Main tools: None reported');
    expect(toClaudeSession({ running: true }).activity).toBeNull();
  });

  test('a long active tool list stays compact', () => {
    const activeTools = Array.from({ length: 5 }, (_, i) => ({ ...mainTool, id: `tool-${i}`, name: `Tool${i}` }));
    expect(view({ activeTools }).tools).toBe('Main tools: Tool0 (10 s), Tool1 (10 s), Tool2 (10 s), +2 more');
  });
});

describe('recent sanitized events and polling', () => {
  test('keeps newest-first event order and known names without mutating the snapshot', () => {
    const events = [
      { at: now, kind: 'approval_ended' },
      { at: now - 1_000, kind: 'permission_denied', tool: 'Bash', taskId: 'worker-1' },
      { at: now - 2_000, kind: 'api_retry' },
      { at: now - 3_000, kind: 'session_failed' },
    ];
    expect(view({ events }).events).toEqual([
      'just now · Approval ended', '1 s ago · Permission denied · Bash · worker worker-1',
      '2 s ago · Model request retried', '3 s ago · Session failed',
    ]);
    expect(events[0]?.kind).toBe('approval_ended');
  });

  test('display picks only safe task, tool and event fields', () => {
    const privateFields = { description: 'private-description', prompt: 'private-prompt', summary: 'private-summary', toolArgs: { command: 'private-command' } };
    const safe = view({
      ...privateFields,
      tasks: [{ ...task, ...privateFields }],
      activeTools: [{ ...mainTool, ...privateFields }],
      events: [{ at: now, kind: 'tool_started', tool: 'Read', ...privateFields }],
    });
    expect(JSON.stringify(safe)).not.toContain('private-');
    expect(safe.events).toEqual(['just now · Tool started · Read']);
  });

  test('only an open Harness observing a running SDK opts into two-second polling', () => {
    const sdk = toClaudeSession({ running: true, runner: 'sdk' });
    expect(sessionPollMs(sdk, true)).toBe(2_000);
    expect(sessionPollMs(sdk, false)).toBe(10_000);
    expect(sessionPollMs(toClaudeSession({ running: false, runner: 'sdk' }), true)).toBe(10_000);
    expect(sessionPollMs(toClaudeSession({ running: true, runner: 'cli' }), true)).toBe(10_000);
    expect(sessionPollMs(toClaudeSession({ running: true }), true)).toBe(10_000);
    expect(sessionPollMs(undefined, true)).toBe(10_000);
  });
});
