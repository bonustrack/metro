import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './local.js';

const PROVIDERS = ['bedrock', 'openrouter', 'codex'] as const;

export function currentRoute(dir = agentsDir()): string | null {
  const path = join(dir, 'model.json');
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { provider?: unknown } & Record<string, unknown>;
    const provider = PROVIDERS.find((p) => p === cfg.provider);
    if (provider === undefined) return null;
    const block = cfg[provider];
    const model = typeof block === 'object' && block !== null ? (block as { model?: unknown }).model : undefined;
    return typeof model === 'string' && model !== '' ? `${provider}:${model}` : null;
  } catch {
    return null;
  }
}

export function routeModelEnv(env: NodeJS.ProcessEnv, route: string | null): NodeJS.ProcessEnv {
  if (route === null || (env.ANTHROPIC_MODEL ?? '').trim() !== '') return env;
  return { ...env, ANTHROPIC_MODEL: route };
}
