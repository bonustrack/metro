import { join } from 'node:path';
import { readJson, writeSecure } from '../daemon/secure-fs.js';
import { agentsDir } from '../db/file-source.js';
import { isRecord } from '../daemon/is-record.js';
import type { CodexTokens } from './codex-auth.js';

export const PROVIDERS = ['anthropic', 'bedrock', 'openrouter', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface BedrockSettings {
  region: string;
  apiKey: string;
  model: string;
}

export interface OpenRouterSettings {
  apiKey: string;
  model: string;
}

export interface CodexSettings {
  model: string;
  auth: CodexTokens | null;
}

export interface ModelConfig {
  version: 1;
  provider: Provider;
  bedrock: BedrockSettings;
  openrouter: OpenRouterSettings;
  codex: CodexSettings;
}

export interface Route {
  provider: Provider;
  model: string;
}

export class ModelConfigError extends Error {}

export const MODEL_FILE = 'model.json';
const MAX_FIELD = 512;
const PREFIX_RE = /^(anthropic|bedrock|openrouter|codex):(.+)$/;

const empty = (): ModelConfig => ({
  version: 1,
  provider: 'anthropic',
  bedrock: { region: '', apiKey: '', model: '' },
  openrouter: { apiKey: '', model: '' },
  codex: { model: '', auth: null },
});

const isProvider = (value: unknown): value is Provider =>
  typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function tokensFromDisk(raw: unknown): CodexTokens | null {
  if (!isRecord(raw)) return null;
  const accessToken = text(raw.accessToken);
  const refreshToken = text(raw.refreshToken);
  const accountId = text(raw.accountId);
  if (accessToken === '' || refreshToken === '' || accountId === '') return null;
  return {
    accessToken,
    refreshToken,
    idToken: text(raw.idToken),
    accountId,
    email: maybe(raw.email),
    plan: maybe(raw.plan),
    savedAt: text(raw.savedAt) === '' ? new Date(0).toISOString() : text(raw.savedAt),
  };
}

function fromDisk(raw: unknown): ModelConfig {
  const base = empty();
  if (!isRecord(raw)) return base;
  const bedrock = isRecord(raw.bedrock) ? raw.bedrock : {};
  const openrouter = isRecord(raw.openrouter) ? raw.openrouter : {};
  const codex = isRecord(raw.codex) ? raw.codex : {};
  return {
    version: 1,
    provider: isProvider(raw.provider) ? raw.provider : 'anthropic',
    bedrock: { region: text(bedrock.region), apiKey: text(bedrock.apiKey), model: text(bedrock.model) },
    openrouter: { apiKey: text(openrouter.apiKey), model: text(openrouter.model) },
    codex: { model: text(codex.model), auth: tokensFromDisk(codex.auth) },
  };
}

export function readModelConfig(dir = agentsDir()): ModelConfig {
  return fromDisk(readJson<unknown>(join(dir, MODEL_FILE), null, { warn: 'model-config: model.json is unreadable, so every request goes to Anthropic until it is fixed' }));
}

export function writeModelConfig(cfg: ModelConfig, dir = agentsDir()): void {
  writeSecure(join(dir, MODEL_FILE), JSON.stringify(cfg, null, 2));
}

function field(patch: Record<string, unknown>, key: string, current: string, what: string): string {
  if (!(key in patch)) return current;
  const value = patch[key];
  if (typeof value !== 'string') throw new ModelConfigError(`${what} must be a string`);
  if (value.length > MAX_FIELD) throw new ModelConfigError(`${what} is too long`);
  return value.trim();
}

export function applyModelUpdate(cfg: ModelConfig, patch: unknown): ModelConfig {
  if (!isRecord(patch)) throw new ModelConfigError('body must be a JSON object');
  const provider = 'provider' in patch ? patch.provider : cfg.provider;
  if (!isProvider(provider)) throw new ModelConfigError(`provider must be one of ${PROVIDERS.join(', ')}`);
  const bedrock = isRecord(patch.bedrock) ? patch.bedrock : {};
  const openrouter = isRecord(patch.openrouter) ? patch.openrouter : {};
  const codex = isRecord(patch.codex) ? patch.codex : {};
  return {
    version: 1,
    provider,
    bedrock: {
      region: field(bedrock, 'region', cfg.bedrock.region, 'Bedrock region'),
      apiKey: field(bedrock, 'apiKey', cfg.bedrock.apiKey, 'Bedrock API key'),
      model: field(bedrock, 'model', cfg.bedrock.model, 'Bedrock model'),
    },
    openrouter: {
      apiKey: field(openrouter, 'apiKey', cfg.openrouter.apiKey, 'OpenRouter API key'),
      model: field(openrouter, 'model', cfg.openrouter.model, 'OpenRouter model'),
    },
    codex: { model: field(codex, 'model', cfg.codex.model, 'Codex model'), auth: cfg.codex.auth },
  };
}

export const setCodexAuth = (cfg: ModelConfig, auth: CodexTokens | null): ModelConfig => ({ ...cfg, codex: { ...cfg.codex, auth } });

const CHECKS: Record<Provider, [(cfg: ModelConfig) => boolean, string][]> = {
  anthropic: [],
  bedrock: [
    [(cfg) => cfg.bedrock.apiKey === '', 'Bedrock needs an API key: add it on the Model page.'],
    [(cfg) => cfg.bedrock.region === '', 'Bedrock needs a region: add it on the Model page.'],
  ],
  openrouter: [
    [(cfg) => cfg.openrouter.apiKey === '', 'OpenRouter needs an API key: add it on the Model page.'],
    [(cfg) => cfg.openrouter.model === '', 'OpenRouter needs a model id: choose one on the Model page.'],
  ],
  codex: [
    [(cfg) => cfg.codex.auth === null, 'Codex is not connected: sign in with ChatGPT on the Model page.'],
    [(cfg) => cfg.codex.model === '', 'Codex needs a model id: choose one on the Model page.'],
  ],
};

export function notReady(cfg: ModelConfig, provider: Provider = cfg.provider): string | null {
  return CHECKS[provider].find(([missing]) => missing(cfg))?.[1] ?? null;
}

export function publicModelConfig(cfg: ModelConfig): Record<string, unknown> {
  const auth = cfg.codex.auth;
  return {
    provider: cfg.provider,
    ready: notReady(cfg) === null,
    reason: notReady(cfg),
    bedrock: { region: cfg.bedrock.region, model: cfg.bedrock.model, hasKey: cfg.bedrock.apiKey !== '' },
    openrouter: { model: cfg.openrouter.model, hasKey: cfg.openrouter.apiKey !== '' },
    codex: { model: cfg.codex.model, signedIn: auth !== null, account: auth?.email ?? null, plan: auth?.plan ?? null },
  };
}

function defaultModelFor(provider: Provider, requested: string, cfg: ModelConfig): string {
  if (provider === 'openrouter') return requested.includes('/') ? requested : cfg.openrouter.model;
  if (provider === 'bedrock') return cfg.bedrock.model === '' ? requested : cfg.bedrock.model;
  if (provider === 'codex') return requested.startsWith('gpt-') ? requested : cfg.codex.model;
  return requested;
}

export function resolveRoute(requested: string, cfg: ModelConfig): Route {
  const explicit = PREFIX_RE.exec(requested);
  if (explicit !== null && isProvider(explicit[1]))
    return { provider: explicit[1], model: (explicit[2] ?? '').trim() };
  return { provider: cfg.provider, model: defaultModelFor(cfg.provider, requested, cfg) };
}

export function routeLabel(route: Route): string {
  return route.provider === 'anthropic' ? route.model : `${route.provider}:${route.model}`;
}
