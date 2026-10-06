import { dirname, join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { Activity, failureSummary } from './activity.js';
import { startAgent, type RunningAgent } from './app.js';
import { runnerConfig } from './config.js';

let agent: RunningAgent | null = null;
let activity: Activity | null = null;

async function exit(code: number): Promise<never> {
  await agent?.stop(code === 0);
  process.exit(code);
}

const exitWith = (code: number) => (): void => {
  exit(code).catch(() => process.exit(code));
};

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, exitWith(0));

try {
  const cfg = runnerConfig();
  activity = new Activity(join(dirname(cfg.statePath), 'agent-status.json'));
  agent = await startAgent(cfg, {
    activity,
    lost: () => {
      activity?.fail('The SDK lost its Metro connection. The session will restart.');
      exitWith(1)();
    },
  });
  try {
    await agent.done;
    activity.fail('The Agent SDK session ended unexpectedly.');
  } catch (err) {
    activity.fail(failureSummary(err));
  }
} catch (err) {
  log.error({ reason: failureSummary(err) }, 'sdk-runner: the Agent SDK session failed to start');
}
await exit(1);
