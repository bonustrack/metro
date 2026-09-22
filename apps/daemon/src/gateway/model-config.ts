import { join } from 'node:path';
import { newId } from '@metro-labs/core/ids';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { isRecord } from '@metro-labs/core/is-record';
import type { CodexTokens } from './codex-auth.js';
import { tokensFromDisk as geminiTokensFromDisk, type GeminiTokens } from './gemini-auth.js';

export const PROVIDERS = ['anthropic', 'bedrock', 'openrouter', 'codex', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Connection {
  id: string;
  provider: Provider;
  label: string;
  model: string;
  apiKey: string;
  region: string;
  zdr: boolean;
  codex: CodexTokens | null;
  gemini: GeminiTokens | null;
}

export interface ModelConfig {
  version: 2;
  route: string;
  connections: Connection[];
}

export interface Route {
  connection: Connection;
  model: string;
}

export class ModelConfigError extends Error {}

export const MODEL_FILE = 'model.json';
const MAX_FIELD = 512;
const MAX_LABEL = 60;
const MAX_CONNECTIONS = 20;
const PREFIX_RE = /^(anthropic|bedrock|openrouter|codex|gemini):(.+)$/;
const SMALL_RE = /haiku/i;

export const LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  openrouter: 'OpenRouter',
  codex: 'Codex (ChatGPT)',
  gemini: 'Gemini (Google)',
};

const isProvider = (value: unknown): value is Provider => typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export const empty = (): ModelConfig => ({ version: 2, route: '', connections: [] });

export const newConnection = (provider: Provider, label: string): Connection => ({
  id: newId(),
  provider,
  label,
  model: '',
  apiKey: '',
  region: '',
  zdr: false,
  codex: null,
  gemini: null,
});

function codexFromDisk(raw: unknown): CodexTokens | null {
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

function connectionFromDisk(raw: unknown): Connection | null {
  if (!isRecord(raw) || !isProvider(raw.provider)) return null;
  const id = text(raw.id);
  const provider = raw.provider;
  return {
    id: id === '' ? newId() : id,
    provider,
    label: text(raw.label) === '' ? LABELS[provider] : text(raw.label).slice(0, MAX_LABEL),
    model: text(raw.model),
    apiKey: text(raw.apiKey),
    region: text(raw.region),
    zdr: raw.zdr === true,
    codex: codexFromDisk(raw.codex),
    gemini: geminiTokensFromDisk(raw.gemini),
  };
}

function fromVersionOne(raw: Record<string, unknown>): ModelConfig {
  const block = (name: Provider): Record<string, unknown> => (isRecord(raw[name]) ? raw[name] : {});
  const made: Connection[] = [];
  const keep = (provider: Provider, fill: (c: Connection) => Connection, has: boolean): void => {
    if (has) made.push(fill(newConnection(provider, LABELS[provider])));
  };
  const anthropic = block('anthropic');
  const bedrock = block('bedrock');
  const openrouter = block('openrouter');
  const codex = block('codex');
  const gemini = block('gemini');
  keep('anthropic', (c) => ({ ...c, apiKey: text(anthropic.apiKey), model: text(anthropic.model) }), text(anthropic.apiKey) !== '' || text(anthropic.model) !== '');
  keep('bedrock', (c) => ({ ...c, apiKey: text(bedrock.apiKey), region: text(bedrock.region), model: text(bedrock.model) }), text(bedrock.apiKey) !== '');
  keep('openrouter', (c) => ({ ...c, apiKey: text(openrouter.apiKey), model: text(openrouter.model), zdr: openrouter.zdr === true }), text(openrouter.apiKey) !== '');
  keep('codex', (c) => ({ ...c, model: text(codex.model), codex: codexFromDisk(codex.auth) }), codexFromDisk(codex.auth) !== null);
  keep('gemini', (c) => ({ ...c, model: text(gemini.model), gemini: geminiTokensFromDisk(gemini.auth) }), geminiTokensFromDisk(gemini.auth) !== null);
  const wanted = isProvider(raw.provider) ? raw.provider : 'anthropic';
  return { version: 2, route: made.find((c) => c.provider === wanted)?.id ?? '', connections: made };
}

export function parseModelConfig(raw: unknown): ModelConfig {
  if (!isRecord(raw)) return empty();
  if (!Array.isArray(raw.connections)) return fromVersionOne(raw);
  const connections = raw.connections.flatMap((c: unknown) => connectionFromDisk(c) ?? []).slice(0, MAX_CONNECTIONS);
  const route = text(raw.route);
  return { version: 2, route: connections.some((c) => c.id === route) ? route : (connections[0]?.id ?? ''), connections };
}

export function readModelConfig(dir = agentsDir()): ModelConfig {
  return parseModelConfig(readJson<unknown>(join(dir, MODEL_FILE), null, { warn: 'model-config: model.json is unreadable, so every request goes to Anthropic until it is fixed' }));
}

export function writeModelConfig(cfg: ModelConfig, dir = agentsDir()): void {
  writeSecure(join(dir, MODEL_FILE), JSON.stringify(cfg, null, 2));
}

export const connectionOf = (cfg: ModelConfig, id: string): Connection | null => cfg.connections.find((c) => c.id === id) ?? null;

export const routedConnection = (cfg: ModelConfig): Connection | null => connectionOf(cfg, cfg.route);

export function requireConnection(cfg: ModelConfig, id: string): Connection {
  const found = connectionOf(cfg, id);
  if (found === null) throw new ModelConfigError('no such connection');
  return found;
}

const PASSTHROUGH = 'Nothing is connected: the request carries the Claude Code login of the session that sent it.';

const CHECKS: Record<Provider, [(c: Connection) => boolean, string][]> = {
  anthropic: [],
  bedrock: [
    [(c) => c.apiKey === '', 'Bedrock needs an API key: add it on the Model page.'],
    [(c) => c.region === '', 'Bedrock needs a region: add it on the Model page.'],
  ],
  openrouter: [
    [(c) => c.apiKey === '', 'OpenRouter needs an API key: add it on the Model page.'],
    [(c) => c.model === '', 'OpenRouter needs a model id: choose one on the Model page.'],
  ],
  codex: [
    [(c) => c.codex === null, 'Codex is not connected: sign in with ChatGPT on the Model page.'],
    [(c) => c.model === '', 'Codex needs a model id: choose one on the Model page.'],
  ],
  gemini: [
    [(c) => c.gemini === null, 'Gemini is not connected: sign in with Google on the Model page.'],
    [(c) => c.model === '', 'Gemini needs a model id: choose one on the Model page.'],
  ],
};

export function notReady(cfg: ModelConfig, conn = routedConnection(cfg)): string | null {
  if (conn === null) return cfg.connections.length === 0 ? null : PASSTHROUGH;
  return CHECKS[conn.provider].find(([missing]) => missing(conn))?.[1] ?? null;
}

export const isSmallModel = (requested: string): boolean => SMALL_RE.test(requested);

const DEFAULTS: Record<Provider, (requested: string, c: Connection) => string> = {
  openrouter: (requested, c) => (requested.includes('/') ? requested : c.model),
  bedrock: (requested, c) => (c.model === '' ? requested : c.model),
  codex: (requested, c) => (requested.startsWith('gpt-') ? requested : c.model),
  gemini: (requested, c) => (requested.startsWith('gemini-') ? requested : c.model),
  anthropic: (requested, c) => (c.model === '' || isSmallModel(requested) ? requested : c.model),
};

function forProvider(cfg: ModelConfig, provider: Provider): Connection | null {
  const routed = routedConnection(cfg);
  if (routed?.provider === provider) return routed;
  return cfg.connections.find((c) => c.provider === provider) ?? null;
}

export function resolveRoute(requested: string, cfg: ModelConfig): Route | null {
  const explicit = PREFIX_RE.exec(requested);
  if (explicit !== null && isProvider(explicit[1])) {
    const conn = forProvider(cfg, explicit[1]);
    return conn === null ? null : { connection: conn, model: (explicit[2] ?? '').trim() };
  }
  const routed = routedConnection(cfg);
  return routed === null ? null : { connection: routed, model: DEFAULTS[routed.provider](requested, routed) };
}

export const routeLabel = (route: Route): string =>
  route.connection.provider === 'anthropic' ? route.model : `${route.connection.provider}:${route.model}`;

export function publicConnection(c: Connection): Record<string, unknown> {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    model: c.model,
    hasKey: c.apiKey !== '',
    region: c.region,
    zdr: c.zdr,
    signedIn: c.codex !== null || c.gemini !== null,
    account: c.codex?.email ?? c.gemini?.email ?? null,
    plan: c.codex?.plan ?? c.gemini?.tier ?? null,
  };
}

export function publicModelConfig(cfg: ModelConfig): Record<string, unknown> {
  const reason = notReady(cfg);
  return { route: cfg.route, ready: reason === null, reason, connections: cfg.connections.map(publicConnection) };
}

const withConnection = (cfg: ModelConfig, id: string, change: (c: Connection) => Connection): ModelConfig => ({
  ...cfg,
  connections: cfg.connections.map((c) => (c.id === id ? change(c) : c)),
});

export const setCodexAuth = (cfg: ModelConfig, id: string, auth: CodexTokens | null): ModelConfig =>
  withConnection(cfg, id, (c) => ({ ...c, codex: auth }));

export const setGeminiAuth = (cfg: ModelConfig, id: string, auth: GeminiTokens | null): ModelConfig =>
  withConnection(cfg, id, (c) => ({ ...c, gemini: auth }));

function field(patch: Record<string, unknown>, key: string, current: string, what: string, max = MAX_FIELD): string {
  if (!(key in patch)) return current;
  const value = patch[key];
  if (typeof value !== 'string') throw new ModelConfigError(`${what} must be a string`);
  if (value.length > max) throw new ModelConfigError(`${what} is too long`);
  return value.trim();
}

function flag(patch: Record<string, unknown>, key: string, current: boolean, what: string): boolean {
  if (!(key in patch)) return current;
  const value = patch[key];
  if (typeof value !== 'boolean') throw new ModelConfigError(`${what} must be true or false`);
  return value;
}

export function labelFor(cfg: ModelConfig, provider: Provider, given: string): string {
  if (given !== '') return given.slice(0, MAX_LABEL);
  const taken = cfg.connections.filter((c) => c.provider === provider).length;
  return taken === 0 ? LABELS[provider] : `${LABELS[provider]} ${String(taken + 1)}`;
}

export function addConnection(cfg: ModelConfig, patch: unknown): ModelConfig {
  if (!isRecord(patch) || !isProvider(patch.provider)) throw new ModelConfigError(`provider must be one of ${PROVIDERS.join(', ')}`);
  if (cfg.connections.length >= MAX_CONNECTIONS) throw new ModelConfigError(`a box keeps at most ${String(MAX_CONNECTIONS)} connections`);
  const made = newConnection(patch.provider, labelFor(cfg, patch.provider, field(patch, 'label', '', 'label', MAX_LABEL)));
  const filled = applyToConnection(made, patch);
  return { ...cfg, route: cfg.route === '' ? filled.id : cfg.route, connections: [...cfg.connections, filled] };
}

export function applyToConnection(c: Connection, patch: Record<string, unknown>): Connection {
  return {
    ...c,
    label: field(patch, 'label', c.label, 'label', MAX_LABEL),
    model: field(patch, 'model', c.model, 'model'),
    apiKey: field(patch, 'apiKey', c.apiKey, 'API key'),
    region: field(patch, 'region', c.region, 'region'),
    zdr: flag(patch, 'zdr', c.zdr, 'zero data retention'),
  };
}

export function updateConnection(cfg: ModelConfig, id: string, patch: unknown): ModelConfig {
  if (!isRecord(patch)) throw new ModelConfigError('body must be a JSON object');
  requireConnection(cfg, id);
  return withConnection(cfg, id, (c) => applyToConnection(c, patch));
}

export function removeConnection(cfg: ModelConfig, id: string): ModelConfig {
  requireConnection(cfg, id);
  const connections = cfg.connections.filter((c) => c.id !== id);
  return { ...cfg, route: cfg.route === id ? (connections[0]?.id ?? '') : cfg.route, connections };
}

export function setRoute(cfg: ModelConfig, id: string): ModelConfig {
  requireConnection(cfg, id);
  return { ...cfg, route: id };
}
