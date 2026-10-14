import { existsSync, readFileSync } from '../agent-user/agent-fs.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { writeHomeText } from '../agent-user/home-fs.js';
import { agentUser } from '../agent-user/user.js';

const FILE = '.claude.json';
const FLAG = 'hasCompletedOnboarding';

export type OnboardingMark = 'marked' | 'already' | 'unreadable';

const given = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value.trim() : undefined;

export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const user = agentUser();
  if (user !== null) return join(user.home, FILE);
  return join(given(env.CLAUDE_CONFIG_DIR) ?? given(env.HOME) ?? homedir(), FILE);
}

function readConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function markOnboardingDone(path = claudeConfigPath()): OnboardingMark {
  const config = readConfig(path);
  if (config === null) return 'unreadable';
  if (config[FLAG] === true) return 'already';
  writeHomeText(path, `${JSON.stringify({ ...config, [FLAG]: true }, null, 2)}\n`, 0o600);
  return 'marked';
}
