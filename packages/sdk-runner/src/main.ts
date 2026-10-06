import { dirname, join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { Activity, failureSummary } from './activity.js';
import { startAgent, type RunningAgent } from './app.js';
import { runnerConfig } from './config.js';

let agent: RunningAgent | null = null;
let starting: Promise<RunningAgent> | null = null;
let activity: Activity | null = null;
let exiting = false;
let cancelRequested = false;

async function exit(code: number, cancelActive = false): Promise<void> {
  if (cancelActive && !cancelRequested) {
    cancelRequested = true;
    if (exiting && agent !== null) await agent.stop(true);
  }
  if (exiting) return;
  exiting = true;
  const running = agent ?? await starting?.catch(() => null);
  await running?.stop(cancelRequested);
  process.exit(code);
}

const exitWith = (code: number, cancelActive = false) => (): void => {
  exit(code, cancelActive).catch(() => process.exit(code));
};

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, exitWith(0));
process.on('SIGUSR2', exitWith(0, true));

try {
  const cfg = runnerConfig();
  activity = new Activity(join(dirname(cfg.statePath), 'agent-status.json'), 'SIGUSR2');
  starting = startAgent(cfg, {
    activity,
    lost: () => {
      if (exiting) return;
      activity?.fail('The SDK lost its Metro connection. The session will restart.');
      exitWith(1)();
    },
  });
  agent = await starting;
  try {
    await agent.done;
    if (!exiting) activity.fail('The Agent SDK session ended unexpectedly.');
  } catch (err) {
    if (!exiting) activity.fail(failureSummary(err));
  }
} catch (err) {
  log.error({ reason: failureSummary(err) }, 'sdk-runner: the Agent SDK session failed to start');
}
await exit(1);
