import { describe, expect, test } from 'bun:test';
import { ApiError } from '@metro-labs/http/api-error';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AGENT_USER_MISSING, chatMemoryLimit, signalChatTurn, spawnChatTurn } from '../src/claude/chat-process.ts';
import { inSessionScope, sessionMemoryLimit } from '../src/claude/memory.ts';

const GIB = 1024 ** 3;
import { waitFor } from './wait.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the chat process', () => {
  test('never starts when the box expects an agent user and has none, and says so with a 503, never a busy 409', () => {
    let refused: unknown;
    try {
      spawnChatTurn(() => true);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 503, message: AGENT_USER_MISSING });
  });

  test('each chat gets a quarter of the session limit, the same hard and soft limit, so three chats stay under the session itself', () => {
    expect(chatMemoryLimit(8 * GIB)).toBe(Math.floor(sessionMemoryLimit(8 * GIB) / 4 / 1024 ** 2) * 1024 ** 2);
    expect(3 * chatMemoryLimit(64 * GIB)).toBeLessThan(sessionMemoryLimit(64 * GIB));
    expect(chatMemoryLimit(2 * GIB)).toBe(512 * 1024 ** 2);
    const limit = String(chatMemoryLimit(8 * GIB));
    const scoped = inSessionScope(['sudo', ['-n', '-u', 'agent', '--', 'env', '-i', 'node', 'cli.js', 'chat']], { metro: true, systemd: true, total: 8 * GIB }, chatMemoryLimit);
    expect(scoped).toEqual(['sudo', ['-n', '/usr/local/lib/metro/root-helper', 'as-agent-scope', limit, limit, 'env', '-i', 'node', 'cli.js', 'chat']]);
  });

  test('SIGTERM goes to the metro chat process, SIGKILL to it and to the group of the runner it started', async () => {
    const cli = spawn('sleep', ['30'], { stdio: 'ignore' });
    const runner = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true });
    const child = cli as unknown as ChildProcessWithoutNullStreams;
    const pid = cli.pid ?? 0;
    const group = runner.pid ?? 0;
    signalChatTurn(child, { pid, group }, 'SIGTERM');
    await waitFor(() => !alive(pid));
    expect(alive(group)).toBe(true);
    signalChatTurn(child, { pid, group }, 'SIGKILL');
    await waitFor(() => !alive(group));
    expect(alive(group)).toBe(false);
  });
});
