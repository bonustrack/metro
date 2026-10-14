import { describe, expect, test } from 'bun:test';
import { toClaudeSession, toClaudeSetup } from '../src/api/claude-box.js';
import { activityIsStale, sessionNote } from '../src/api/runner.js';

describe('observing the session', () => {
  const now = 1_800_000_000_000;
  const activity = { runner: 'sdk', pid: 123, phase: 'working', updatedAt: now, pending: 0, workers: 0, tools: [] };

  test('a tmux process is not SDK readiness', () => {
    for (const phase of ['starting', 'working', 'idle', 'compacting', 'error', 'stopped']) {
      const note = sessionNote(toClaudeSession({ running: true, activity: { ...activity, phase } }), now);
      expect(note).toContain(`Agent SDK reports ${phase}`);
      expect(note).not.toContain('ready');
    }
    expect(sessionNote(toClaudeSession({ running: true, activity: { ...activity, phase: 'approval' } }), now)).toContain('waiting for approval');
    expect(sessionNote(toClaudeSession({ running: true }), now)).toContain('Waiting for Agent SDK status');
    expect(sessionNote(toClaudeSession({ running: true, runner: 'sdk' }), now)).toContain('Waiting for Agent SDK status');
  });

  test('stale or far-future timestamps cannot claim a current SDK state', () => {
    expect(activityIsStale(now - 30_000, now)).toBe(false);
    expect(activityIsStale(now - 30_001, now)).toBe(true);
    expect(activityIsStale(now + 30_001, now)).toBe(true);
    expect(sessionNote(toClaudeSession({ running: true, activity: { ...activity, updatedAt: now - 30_001 } }), now)).toContain('SDK status is stale; last reported working');
  });

  test('stopped sessions keep errors and blockers and explain the explicit Start', () => {
    expect(sessionNote(toClaudeSession({ running: false, autostart: false }), now)).toContain('Press Start');
    expect(sessionNote(toClaudeSession({ running: false, lastError: 'Failed to launch' }), now)).toBe('Not running: Failed to launch');
    expect(sessionNote(toClaudeSession({ running: false, blocked: 'No model' }), now)).toBe('Waiting: No model.');
  });

  test('a daemon that still runs Claude Code asks for an update and never shows its old SDK report or channel state', () => {
    for (const channels of [{ registered: false, reason: 'channels feature is not currently available' }, { registered: true }, undefined]) {
      const note = sessionNote(toClaudeSession({ running: true, runner: 'cli', channels, activity }), now);
      expect(note).toBe('Running on Claude Code. Update Metro to move it to the Agent SDK.');
    }
  });
});

describe('the Harness setup of an older daemon', () => {
  test('the runner choice, its guard and the operator switch are not read', () => {
    const setup = toClaudeSetup({ privacy: true, permissionMode: 'auto', runner: 'cli', runnerAllowed: false, sdkOnLogin: true });
    expect(setup).not.toHaveProperty('runner');
    expect(setup).not.toHaveProperty('runnerAllowed');
    expect(setup).not.toHaveProperty('sdkOnLogin');
  });
});
