import { describe, expect, test } from 'bun:test';
import { toClaudeSetup } from '../src/api/claude-box.js';
import { runnerNote, sdkSelectable } from '../src/api/runner.js';

const answer = (over: Record<string, unknown>): ReturnType<typeof toClaudeSetup> => toClaudeSetup({ privacy: true, permissionMode: 'auto', runner: 'cli', ...over });

describe('the Runner choice follows the terms guard the daemon answers', () => {
  test('on a Claude login the Agent SDK cannot be picked and the note says it needs an API key', () => {
    const login = answer({ runnerAllowed: false, sdkOnLogin: false });
    expect(sdkSelectable(login)).toBe(false);
    expect(runnerNote(login)).toContain('Agent SDK needs an API key');
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
