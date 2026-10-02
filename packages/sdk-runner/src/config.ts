import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export interface RunnerConfig {
  mcpUrl: string;
  key: string;
  cwd: string;
  claude: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  prompt: string | null;
  statePath: string;
  claudeDir: string;
}

const given = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = given(env[name]);
  if (value === null) throw new Error(`${name} is not set; start the runner with metro agent`);
  return value;
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function runnerConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RunnerConfig {
  const home = given(env.HOME) ?? homedir();
  return {
    mcpUrl: required(env, 'METRO_RUNNER_MCP_URL'),
    key: required(env, 'METRO_AGENT_KEY'),
    cwd: realDir(cwd),
    claude: given(env.METRO_RUNNER_CLAUDE),
    model: given(env.METRO_RUNNER_MODEL),
    permissionMode: env.METRO_RUNNER_PERMISSION_MODE === 'bypass' ? 'bypassPermissions' : 'auto',
    prompt: given(env.METRO_RUNNER_PROMPT),
    statePath: given(env.METRO_RUNNER_STATE) ?? join(home, '.metro', 'agent-session.json'),
    claudeDir: given(env.CLAUDE_CONFIG_DIR) ?? join(home, '.claude'),
  };
}
