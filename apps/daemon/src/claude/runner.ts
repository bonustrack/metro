import { log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import type { CodexMethod } from '../gateway/codex-auth.js';
import { connectionOf, readModelConfig, routedConnection, type Connection, type ModelConfig } from '../gateway/model-config.js';
import { readSetupState, writeSetupState } from './setup-state.js';

const RUNNERS = ['cli', 'sdk'] as const;
export type HarnessRunner = (typeof RUNNERS)[number];

export const SDK_NEEDS_KEY =
  'The Agent SDK runner needs an API key or a ChatGPT sign-in on every model the Model page lists, the first one and each fallback: use Anthropic with an API key, Amazon Bedrock, OpenRouter, or a signed-in Codex connection (with ChatGPT or with a code). Anthropic does not allow products built on the Agent SDK to use a Claude login, so on a login it runs only where the Metro operator allows it.';

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

const SDK_ON_CODEX: Record<CodexMethod, boolean> = { chatgpt: true, code: true };

const permitted = (conn: Connection | null): boolean => conn !== null && (conn.apiKey !== '' || (conn.codex !== null && SDK_ON_CODEX[conn.codex.method]));

const servingConnections = (cfg: ModelConfig): (Connection | null)[] => [routedConnection(cfg), ...(cfg.fallbacks ?? []).map((f) => connectionOf(cfg, f.connection))];

const permittedRoute = (cfg: ModelConfig): boolean => servingConnections(cfg).every(permitted);

export const sdkAllowed = (agents = agentsDir(), cfg: ModelConfig = readModelConfig(agents)): boolean => permittedRoute(cfg) || sdkOnLogin(agents);

export const runnerInUse = (agents = agentsDir(), cfg?: ModelConfig): HarnessRunner => (harnessRunner(agents) === 'sdk' && sdkAllowed(agents, cfg) ? 'sdk' : 'cli');

export function runnerModel(cfg: ModelConfig): string | null {
  const conn = routedConnection(cfg);
  if (conn === null || conn.model === '') return null;
  return conn.provider === 'anthropic' ? conn.model : `${conn.provider}:${conn.model}`;
}

export function settleRunner(agents = agentsDir()): boolean {
  if (harnessRunner(agents) !== 'sdk' || sdkAllowed(agents)) return false;
  setHarnessRunner('cli', agents);
  log.warn('claude-runner: a model on the Model page (the first one or a fallback) has neither an API key nor a ChatGPT sign-in, and this box is not allowed the Agent SDK on a Claude login, so the agent goes back to the Claude Code session');
  return true;
}
