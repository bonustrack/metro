import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = '.claude.json';
const FLAG = 'hasCompletedOnboarding';

export type OnboardingMark = 'marked' | 'already' | 'unreadable';

const given = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value.trim() : undefined;

export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(given(env.CLAUDE_CONFIG_DIR) ?? given(env.HOME) ?? homedir(), FILE);
}

function readConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function markOnboardingDone(path = claudeConfigPath()): OnboardingMark {
  const config = readConfig(path);
  if (config === null) return 'unreadable';
  if (config[FLAG] === true) return 'already';
  writeFileSync(path, `${JSON.stringify({ ...config, [FLAG]: true }, null, 2)}\n`, { mode: 0o600 });
  return 'marked';
}
