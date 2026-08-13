import { describe, expect, test } from 'bun:test';
import {
  KEY_PLACEHOLDER,
  RESUME_COMMAND,
  START_COMMAND,
  registerCommand,
} from '../src/components/start-session';

describe('the commands the start page shows', () => {
  test('the start command is the channel flag naming the metro server', () => {
    expect(START_COMMAND).toBe(
      'claude --dangerously-load-development-channels server:metro',
    );
  });

  test('the resume variant is the same command with -c in front of the flag', () => {
    expect(RESUME_COMMAND).toBe(START_COMMAND.replace('claude ', 'claude -c '));
  });

  test('the registration line is the shape the daemon emits, with the key left out', () => {
    expect(registerCommand('https://mcp.metro.box/mcp')).toBe(
      `claude mcp add --transport http metro "https://mcp.metro.box/mcp?token=${KEY_PLACEHOLDER}"`,
    );
  });

  test('a daemon that reports no endpoint still yields a usable line', () => {
    expect(registerCommand('')).toBe(
      `claude mcp add --transport http metro "https://mcp.metro.box/mcp?token=${KEY_PLACEHOLDER}"`,
    );
  });

  test('no command on the page can carry a real token', () => {
    for (const command of [
      START_COMMAND,
      RESUME_COMMAND,
      registerCommand('https://mcp.metro.box/mcp'),
      registerCommand(''),
    ])
      expect(command).not.toMatch(/token=(?!<)/);
  });
});
