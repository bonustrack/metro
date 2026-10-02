import { errMsg, log } from '@metro-labs/core/log';
import { startAgent, type RunningAgent } from './app.js';
import { runnerConfig } from './config.js';

let agent: RunningAgent | null = null;

async function exit(code: number): Promise<never> {
  await agent?.stop();
  process.exit(code);
}

const exitWith = (code: number) => (): void => {
  exit(code).catch(() => process.exit(code));
};

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, exitWith(0));

try {
  agent = await startAgent(runnerConfig(), {
    speech: {
      say: (text) => {
        log.debug({ chars: text.length }, 'sdk-runner: speech');
      },
      done: () => {
        log.debug('sdk-runner: speech done');
      },
    },
    lost: (reason) => {
      log.error({ reason }, 'sdk-runner: lost the metro link; exiting so the session watcher starts the runner again');
      exitWith(1)();
    },
  });
  await agent.done;
  log.warn('sdk-runner: the Agent SDK session ended');
} catch (err) {
  log.error({ err: errMsg(err) }, 'sdk-runner: the Agent SDK session failed');
}
await exit(1);
