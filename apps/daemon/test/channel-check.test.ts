import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelState, forgetChannelState, mcpLogDir, noteChannelState, readChannelState } from '../src/claude/channel-check.js';

const STARTED = Date.parse('2026-10-13T15:50:46.000Z');
const SKIPPED = 'Channel notifications skipped: channels feature is not currently available';
let home = '';

const entry = (debug: string): string => JSON.stringify({ debug, timestamp: '2026-10-13T15:50:47.852Z', sessionId: 's' });

const writeLog = (name: string, lines: string[]): void => {
  const dir = mcpLogDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${lines.map(entry).join('\n')}\n`);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metro-channel-check-'));
  forgetChannelState();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('whether Claude Code registered the metro channel', () => {
  test('the log folder follows the home folder the way Claude Code names it', () => {
    expect(mcpLogDir('/home/agent')).toBe('/home/agent/.cache/claude-cli-nodejs/-home-agent/mcp-logs-metro');
  });

  test('reads the reason when the channel was skipped, and a registration otherwise', () => {
    writeLog('2026-10-13T15-50-47-382Z.jsonl', ['Successfully connected (transport: http) in 406ms', SKIPPED, 'Calling MCP tool: read']);
    expect(readChannelState(home, STARTED)).toEqual({ registered: false, reason: 'channels feature is not currently available' });
    writeLog('2026-10-13T15-51-00-000Z.jsonl', ['Channel notifications registered']);
    expect(readChannelState(home, STARTED)).toEqual({ registered: true, reason: null });
  });

  test('a log from before this start, a log still being written, or no log at all says nothing yet', () => {
    expect(readChannelState(home, STARTED)).toBeNull();
    writeLog('2026-10-13T12-07-57-949Z.jsonl', [SKIPPED]);
    expect(readChannelState(home, STARTED)).toBeNull();
    writeLog('2026-10-13T15-50-47-382Z.jsonl', ['Starting connection with timeout of 30000ms']);
    expect(readChannelState(home, STARTED)).toBeNull();
  });

  test('the state is kept for the session status until the next start forgets it', () => {
    expect(noteChannelState(home, STARTED)).toBe(false);
    writeLog('2026-10-13T15-50-47-382Z.jsonl', [SKIPPED]);
    expect(noteChannelState(home, STARTED)).toBe(true);
    expect(channelState()).toEqual({ registered: false, reason: 'channels feature is not currently available' });
    forgetChannelState();
    expect(channelState()).toBeNull();
  });
});
