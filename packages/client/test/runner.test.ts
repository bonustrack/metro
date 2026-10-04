import { describe, expect, test } from 'bun:test';
import { toClaudeSetup } from '../src/api/claude-box.js';
import { modelNote, runnerNote, sdkSelectable } from '../src/api/runner.js';

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

describe('the Model page says how a switch reaches the agent', () => {
  test('the Agent SDK session takes it at once, the Claude Code session restarts, and an unknown setup reads as a restart', () => {
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true }))).toContain('no restart');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true }))).toContain('cannot pick another model');
    expect(modelNote(answer({ runner: 'cli', runnerAllowed: true }))).toContain('restarts the agent');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: false }))).toContain('restarts the agent');
    expect(modelNote(undefined)).toContain('restarts the agent');
  });

  test('on an API-key route it warns that a model without a key puts the agent back on Claude Code, and on an allowed login it does not', () => {
    expect(runnerNote(answer({ runnerAllowed: false, sdkOnLogin: false }))).toContain('each fallback');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true, sdkOnLogin: false }))).toContain('Every model in the list needs an API key');
    expect(modelNote(answer({ runner: 'sdk', runnerAllowed: true, sdkOnLogin: true }))).not.toContain('API key');
  });
});
