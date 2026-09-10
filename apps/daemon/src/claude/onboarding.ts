import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';

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
    return isRecord(parsed) ? parsed : null;
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

const TRUST = 'hasTrustDialogAccepted';

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function trustFolder(dir: string, path = claudeConfigPath()): OnboardingMark {
  const config = readConfig(path);
  if (config === null) return 'unreadable';
  const key = realDir(dir);
  const projects = isRecord(config.projects) ? config.projects : {};
  const project = isRecord(projects[key]) ? projects[key] : {};
  if (project[TRUST] === true) return 'already';
  const next = { ...config, projects: { ...projects, [key]: { ...project, [TRUST]: true } } };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return 'marked';
}
