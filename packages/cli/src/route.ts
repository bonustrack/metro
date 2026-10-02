import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './local.js';

const PROVIDERS = new Set(['bedrock', 'openrouter', 'codex', 'gemini']);
const ANTHROPIC = 'anthropic';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

interface Routed {
  provider: string;
  model: string;
}

function routedIn(cfg: unknown): Routed | null {
  if (typeof cfg !== 'object' || cfg === null) return null;
  const { route, connections } = cfg as { route?: unknown; connections?: unknown };
  if (!Array.isArray(connections)) return null;
  const conn: unknown = connections.find((c: unknown) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === route);
  if (typeof conn !== 'object' || conn === null) return null;
  const model = text((conn as { model?: unknown }).model);
  return model === '' ? null : { provider: text((conn as { provider?: unknown }).provider), model };
}

function routed(dir: string): Routed | null {
  const path = join(dir, 'model.json');
  if (!existsSync(path)) return null;
  try {
    return routedIn(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

const prefixed = (found: Routed | null): string | null => (found !== null && PROVIDERS.has(found.provider) ? `${found.provider}:${found.model}` : null);

export const currentRoute = (dir = agentsDir()): string | null => prefixed(routed(dir));

export function currentModel(dir = agentsDir()): string | null {
  const found = routed(dir);
  return found?.provider === ANTHROPIC ? found.model : prefixed(found);
}

export function routeModelEnv(env: NodeJS.ProcessEnv, route: string | null): NodeJS.ProcessEnv {
  if (route === null || (env.ANTHROPIC_MODEL ?? '').trim() !== '') return env;
  return { ...env, ANTHROPIC_MODEL: route };
}

export type PermissionMode = 'auto' | 'bypass';

export const permissionMode = (dir = agentsDir()): PermissionMode => (setupField(dir, 'permissionMode') === 'bypass' ? 'bypass' : 'auto');

function setupField(dir: string, field: string): unknown {
  const path = join(dir, 'claude-setup.json');
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return state[field];
  } catch {
    return undefined;
  }
}

export const harnessRunner = (dir = agentsDir()): 'cli' | 'sdk' => (setupField(dir, 'runner') === 'sdk' ? 'sdk' : 'cli');

export function systemPrompt(dir = agentsDir()): string | null {
  const path = join(dir, 'system-prompt.md');
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}
