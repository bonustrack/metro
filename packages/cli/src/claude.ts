import { spawnSync } from 'node:child_process';

const CHANNEL_FLAGS = ['--dangerously-load-development-channels', 'server:metro'];

export const claudeArgs = (extra: string[]): string[] => [
  ...CHANNEL_FLAGS,
  ...extra,
];

export function launchClaude(extra: string[]): Promise<number> {
  const leaveToChild = (): undefined => undefined;
  process.on('SIGINT', leaveToChild);
  process.on('SIGTERM', leaveToChild);
  const res = spawnSync('claude', claudeArgs(extra), { stdio: 'inherit' });
  if (res.error !== undefined)
    throw new Error(
      'the `claude` command is not on PATH — install Claude Code first',
    );
  return Promise.resolve(res.status ?? 1);
}
