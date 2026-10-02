import { log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import { readModelConfig, routedConnection, type ModelConfig } from '../gateway/model-config.js';
import { readSetupState, writeSetupState } from './setup-state.js';

const RUNNERS = ['cli', 'sdk'] as const;
export type HarnessRunner = (typeof RUNNERS)[number];

export const SDK_NEEDS_KEY =
  'The Agent SDK runner needs an API key: route the Model page to Anthropic with an API key, Amazon Bedrock or OpenRouter. Anthropic does not allow products built on the Agent SDK to use a Claude login, so on a login it runs only where the Metro operator allows it.';

export const isHarnessRunner = (value: unknown): value is HarnessRunner => RUNNERS.some((r) => r === value);

export function harnessRunner(agents = agentsDir()): HarnessRunner {
  const runner = readSetupState(agents).runner;
  return isHarnessRunner(runner) ? runner : 'cli';
}

export function setHarnessRunner(runner: HarnessRunner, agents = agentsDir()): void {
  writeSetupState(agents, { runner });
}

export const sdkOnLogin = (agents = agentsDir()): boolean => readSetupState(agents).sdkOnLogin === true;

export function setSdkOnLogin(on: boolean, agents = agentsDir()): void {
  writeSetupState(agents, { sdkOnLogin: on });
}

export const keyedRoute = (cfg: ModelConfig): boolean => (routedConnection(cfg)?.apiKey ?? '') !== '';

export const sdkAllowed = (agents = agentsDir(), cfg: ModelConfig = readModelConfig(agents)): boolean => keyedRoute(cfg) || sdkOnLogin(agents);

export const runnerInUse = (agents = agentsDir()): HarnessRunner => (harnessRunner(agents) === 'sdk' && sdkAllowed(agents) ? 'sdk' : 'cli');

export function settleRunner(agents = agentsDir()): boolean {
  if (harnessRunner(agents) !== 'sdk' || sdkAllowed(agents)) return false;
  setHarnessRunner('cli', agents);
  log.warn('claude-runner: the model route has no API key and this box is not allowed the Agent SDK on a Claude login, so the agent goes back to the Claude Code session');
  return true;
}
