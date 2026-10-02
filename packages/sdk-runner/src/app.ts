import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { errMsg, log } from '@metro-labs/core/log';
import { approvalsThrough } from './approvals.js';
import type { RunnerConfig } from './config.js';
import { MetroLink } from './link.js';
import { Runner, runnerOptions } from './runner.js';
import { SessionStore } from './session-store.js';
import type { SpeechSink } from './speech.js';
import { metroTools, type MetroTools } from './tool-proxy.js';

export interface RunningAgent {
  runner: Runner;
  link: MetroLink;
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface AppHooks {
  speech: SpeechSink;
  lost(reason: string): void;
  observe?: (message: SDKMessage) => void;
  env?: NodeJS.ProcessEnv;
  compactAt?: number;
}

export async function startAgent(cfg: RunnerConfig, hooks: AppHooks): Promise<RunningAgent> {
  const store = new SessionStore(cfg.statePath, cfg.claudeDir, cfg.cwd);
  let tools: MetroTools | null = null;
  const runner = new Runner({ store, sink: hooks.speech, readOnly: (tool) => tools?.readOnly(tool) ?? false, ...(hooks.compactAt === undefined ? {} : { compactAt: hooks.compactAt }) });
  const link = await MetroLink.open(cfg.mcpUrl, cfg.key, {
    channel: (event) => {
      log.info({ line: event.meta.line, from: event.meta.from }, 'sdk-runner: chat in');
      runner.chat(event);
    },
    toolsChanged: () => {
      tools?.changed();
    },
    lost: (reason) => {
      hooks.lost(reason);
    },
  });
  tools = metroTools(link);
  const resume = store.resumable();
  log.info({ resume, front: cfg.frontModel, worker: cfg.workerModel, mode: cfg.permissionMode }, 'sdk-runner: starting the Agent SDK session');
  runner.start(runnerOptions(cfg, tools, approvalsThrough(link), resume, hooks.env));
  const stop = async (): Promise<void> => {
    runner.close();
    await link.close().catch((err: unknown) => {
      log.debug({ err: errMsg(err) }, 'sdk-runner: closing the metro link failed');
    });
  };
  return { runner, link, done: runner.run(hooks.observe), stop };
}
