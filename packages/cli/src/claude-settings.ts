import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_FLAGS } from './provider-flags.js';

const CONFLICTING = [...PROVIDER_FLAGS, 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function settingsFiles(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim() ?? '';
  const configDir = explicit === '' ? join(homedir(), '.claude') : explicit;
  return [
    ...new Set([
      join(configDir, 'settings.json'),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
    ]),
  ];
}

function envBlock(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown };
    const block = parsed.env;
    return typeof block === 'object' && block !== null ? (block as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function settingsConflicts(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const block = envBlock(file);
    for (const key of CONFLICTING) {
      const value = block[key];
      if (typeof value === 'string' && value.trim() !== '') out.push(`${file}: ${key}`);
    }
  }
  return out;
}
