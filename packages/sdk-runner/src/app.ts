import { dirname, join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AutomationStore } from '@metro-labs/core/automation-store';
import { errMsg, log } from '@metro-labs/core/log';
import { failureSummary, type Activity } from './activity.js';
import { approvalsThrough } from './approvals.js';
import type { RunnerConfig } from './config.js';
import { MetroLink } from './link.js';
import { Runner, runnerOptions } from './runner.js';
import { SessionStore } from './session-store.js';
import { claimRunner } from './singleton.js';
import { metroTools, type MetroTools } from './tool-proxy.js';

export interface RunningAgent {
  runner: Runner;
  link: MetroLink;
  done: Promise<void>;
  stop(cancelActive?: boolean): Promise<void>;
}

export interface AppHooks {
  lost(reason: string): void;
  observe?: (message: SDKMessage) => void;
  env?: NodeJS.ProcessEnv;
  compactAt?: number;
  activity?: Activity;
}

async function connected(cfg: RunnerConfig, hooks: AppHooks, release: () => Promise<void>): Promise<RunningAgent> {
  const store = new SessionStore(cfg.statePath, cfg.claudeDir, cfg.cwd);
  let tools: MetroTools | null = null;
  const automationStore = new AutomationStore(join(dirname(cfg.statePath), 'automation'));
  const runner = new Runner({ store, automationStore, readOnly: (tool) => tools?.readOnly(tool) ?? false, ...hooks });
  const link = await MetroLink.open(cfg.mcpUrl, cfg.key, {
    channel: (event) => { runner.chat(event); },
    call: (notice) => { runner.calls.notice(notice); },
    callState: (state) => { runner.calls.reconcile(state.route); },
    toolsChanged: () => { tools?.changed(); },
    model: (model) => {
      log.info({ model }, 'sdk-runner: the Model page picked a model');
      runner.switchModel(model).catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'sdk-runner: could not switch the model');
      });
    },
    lost: (reason) => { hooks.lost(reason); },
  });
  let stopped = false;
  const stop = async (cancelActive = false): Promise<void> => {
    if (stopped) {
      if (cancelActive) runner.close(true);
      return;
    }
    stopped = true;
    runner.close(cancelActive);
    await link.close().catch(() => { log.debug('sdk-runner: closing the metro link failed'); });
    hooks.activity?.stop();
    await release();
  };
  try {
    tools = metroTools(link);
    const resume = store.resumable();
    log.info({ resume, model: cfg.model, mode: cfg.permissionMode }, 'sdk-runner: starting the Agent SDK session');
    const approvals = approvalsThrough(link, (id, ask) => { hooks.activity?.approval(id, ask); }, (tool, input) => runner.calls.approval(tool, input));
    runner.start(runnerOptions(cfg, tools, approvals, resume, hooks.env));
    return { runner, link, done: runner.run(hooks.observe), stop };
  } catch (err) {
    runner.close(false);
    await link.close().catch(() => { log.debug('sdk-runner: closing the metro link failed'); });
    throw err;
  }
}

export async function startAgent(cfg: RunnerConfig, hooks: AppHooks): Promise<RunningAgent> {
  const release = await claimRunner(cfg.cwd);
  try {
    hooks.activity?.start();
    return await connected(cfg, hooks, release);
  } catch (err) {
    hooks.activity?.fail(failureSummary(err));
    hooks.activity?.stop();
    await release().catch(() => { log.warn('sdk-runner: releasing process ownership failed'); });
    throw err;
  }
}
