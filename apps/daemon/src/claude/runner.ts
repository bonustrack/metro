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

export const sdkAllowed = (agents = agentsDir(), cfg: ModelConfig = readModelConfig(agents), loginAllowed = sdkOnLogin(agents)): boolean => permittedRoute(cfg) || loginAllowed;

export const sdkConnectionAllowed = (connection: Connection, agents = agentsDir()): boolean => permitted(connection) || sdkOnLogin(agents);

export function runnerModel(cfg: ModelConfig): string | null {
  const conn = routedConnection(cfg);
  if (conn === null || conn.model === '') return null;
  return conn.provider === 'anthropic' ? conn.model : `${conn.provider}:${conn.model}`;
}
