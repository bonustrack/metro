import { describe, expect, test } from 'bun:test';
import { toClaudeSession, toClaudeSetup } from '../src/api/claude-box.js';
import { activityIsStale, modelNote, OPERATOR_NOTE, runnerNote, sdkSelectable, sessionNote } from '../src/api/runner.js';

const answer = (over: Record<string, unknown>): ReturnType<typeof toClaudeSetup> => toClaudeSetup({ privacy: true, permissionMode: 'auto', runner: 'cli', ...over });

describe('the Runner choice follows the terms guard the daemon answers', () => {
  test('on a Claude login the Agent SDK cannot be picked and the note says it needs an API key', () => {
    const login = answer({ runnerAllowed: false, sdkOnLogin: false });
    expect(sdkSelectable(login)).toBe(false);
    expect(runnerNote(login)).toContain('Agent SDK needs an API key');
    expect(runnerNote(login)).toContain('a signed-in Codex connection (with ChatGPT or with a code)');
  });

  test('an API-key route or the operator allowing the login opens it, and the note says which', () => {
    expect(sdkSelectable(answer({ runnerAllowed: true, sdkOnLogin: false }))).toBe(true);
    expect(runnerNote(answer({ runnerAllowed: true, sdkOnLogin: false }))).not.toContain('API key');
    expect(runnerNote(answer({ runnerAllowed: true, sdkOnLogin: true }))).toContain('The Metro operator allows');
  });

  test('a daemon without the guard shows no operator switch, and a runner already on the Agent SDK can always be switched back', () => {
    expect(answer({}).sdkOnLogin).toBeNull();
    expect(answer({}).runnerAllowed).toBe(false);
    expect(sdkSelectable(answer({ runner: 'sdk', runnerAllowed: false }))).toBe(true);
  });
});

describe('switching and observing a session', () => {
  const now = 1_800_000_000_000;
  const activity = { runner: 'sdk', pid: 123, phase: 'working', updatedAt: now, pending: 0, workers: 0, tools: [] };

  test('explains the explicit stop and start and the separate saved conversations', () => {
    const note = runnerNote(answer({ runnerAllowed: true }));
    expect(note).toContain('finish active work, press Stop, choose a runner, then press Start');
    expect(note).toContain('Each runner keeps its own saved conversation');
    expect(note).toContain('Chats from one runner are not copied to the other');
    expect(note).toContain('Voice calls remain separate');
    expect(note).toContain('it does not wait for work to finish');
    expect(OPERATOR_NOTE).toContain('let active work and queued messages finish, then Stop');
    expect(OPERATOR_NOTE).toContain('stays stopped until Start');
  });

  test('a tmux process is not SDK readiness', () => {
    for (const phase of ['starting', 'working', 'idle', 'compacting', 'error', 'stopped']) {
      const note = sessionNote(toClaudeSession({ running: true, activity: { ...activity, phase } }), now);
      expect(note).toContain(`Agent SDK reports ${phase}`);
      expect(note).not.toContain('ready');
    }
    expect(sessionNote(toClaudeSession({ running: true, activity: { ...activity, phase: 'approval' } }), now)).toContain('waiting for approval');
    expect(sessionNote(toClaudeSession({ running: true }), now)).toBe('Running.');
    expect(sessionNote(toClaudeSession({ running: true, runner: 'sdk' }), now)).toContain('Waiting for Agent SDK status');
    expect(sessionNote(toClaudeSession({ running: true, runner: 'cli', activity }), now)).toBe('Running.');
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
});

describe('the Model page says how a switch reaches the agent', () => {
  test('the Agent SDK session takes it at once, the Claude Code session restarts, and an unknown setup reads as a restart', () => {
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true }))).toContain('no restart');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true }))).toContain('cannot pick another model');
    expect(modelNote(answer({ runner: 'cli', runnerAllowed: true }))).toContain('restarts the agent');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: false }))).toContain('Agent SDK is selected but blocked');
    expect(modelNote(undefined)).toContain('restarts the agent');
  });

  test('unallowed models block the SDK rather than silently switching runners', () => {
    expect(runnerNote(answer({ runnerAllowed: false, sdkOnLogin: false }))).toContain('each fallback');
    const note = modelNote(answer({ runner: 'sdk', runnerAllowed: true, sdkOnLogin: false }));
    expect(note).toContain('Every model in the list needs an API key');
    expect(note).toContain('refused while the Agent SDK is running');
    expect(note).toContain('stays selected but cannot start');
    expect(note).not.toContain('goes back to Claude Code');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true, sdkOnLogin: true }))).not.toContain('API key');
  });
});
