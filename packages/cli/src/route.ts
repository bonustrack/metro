import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './local.js';

const PROVIDERS = new Set(['bedrock', 'openrouter', 'codex', 'gemini']);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function routeIn(cfg: unknown): string | null {
  if (typeof cfg !== 'object' || cfg === null) return null;
  const { route, connections } = cfg as { route?: unknown; connections?: unknown };
  if (!Array.isArray(connections)) return null;
  const conn: unknown = connections.find((c: unknown) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === route);
  if (typeof conn !== 'object' || conn === null) return null;
  const provider = text((conn as { provider?: unknown }).provider);
  const model = text((conn as { model?: unknown }).model);
  return PROVIDERS.has(provider) && model !== '' ? `${provider}:${model}` : null;
}

function modelConfig(dir: string): unknown {
  const path = join(dir, 'model.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export const currentRoute = (dir = agentsDir()): string | null => routeIn(modelConfig(dir));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function anthropicRoute(dir = agentsDir()): boolean {
  const cfg = modelConfig(dir);
  if (!isRecord(cfg) || !Array.isArray(cfg.connections)) return true;
  const connections = cfg.connections.filter(isRecord);
  const routed = connections.find((c) => c.id === cfg.route) ?? connections[0];
  return routed === undefined || routed.provider === 'anthropic';
}

export function routeModelEnv(env: NodeJS.ProcessEnv, route: string | null): NodeJS.ProcessEnv {
  if (route === null || (env.ANTHROPIC_MODEL ?? '').trim() !== '') return env;
  return { ...env, ANTHROPIC_MODEL: route };
}

export type PermissionMode = 'auto' | 'bypass';

export function permissionMode(dir = agentsDir()): PermissionMode {
  const path = join(dir, 'claude-setup.json');
  if (!existsSync(path)) return 'auto';
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { permissionMode?: unknown };
    return state.permissionMode === 'bypass' ? 'bypass' : 'auto';
  } catch {
    return 'auto';
  }
}

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
