import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ENTRY = join(import.meta.dir, '..', 'src', 'chat.ts');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
};

async function chatLike(runner: string, graceMs: number): Promise<{ pid: number; group: number; exited: () => boolean; at: () => number }> {
  const script = `import { runChatChild } from ${JSON.stringify(ENTRY)}; process.exitCode = await runChatChild('sh', ['-c', ${JSON.stringify(runner)}], process.env, ${String(graceMs)});`;
  const cli = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let exitedAt = 0;
  cli.on('exit', () => {
    exitedAt = Date.now();
  });
  const line = await new Promise<string>((resolve) => {
    cli.stdout.once('data', (chunk: Buffer) => {
      resolve(chunk.toString('utf8').split('\n')[0] ?? '');
    });
  });
  const pids = JSON.parse(line) as { t: string; pid: number; group: number };
  expect(pids.t).toBe('pid');
  expect(pids.pid).toBe(cli.pid ?? 0);
  return { pid: pids.pid, group: pids.group, exited: () => exitedAt > 0, at: () => exitedAt };
}

describe('metro chat ends its runner when it is told to', () => {
  test('SIGTERM reaches the runner group, which ends at once when it can', async () => {
    const run = await chatLike('sleep 30', 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = Date.now();
    process.kill(run.pid, 'SIGTERM');
    await until(run.exited);
    expect(run.exited()).toBe(true);
    expect(run.at() - sent).toBeLessThan(2_000);
    expect(alive(run.group)).toBe(false);
  });

  test('a runner that ignores SIGTERM is killed with its whole group after the grace', async () => {
    const run = await chatLike('trap "" TERM; sleep 30 & wait', 300);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(run.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(alive(run.group)).toBe(true);
    await until(run.exited);
    expect(run.exited()).toBe(true);
    await until(() => !alive(run.group));
    expect(alive(run.group)).toBe(false);
  });
});
