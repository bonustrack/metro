import { join } from 'node:path';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { agentsDir } from '../agents/files.js';
import { readModelConfig, type ModelConfig } from '../gateway/model-config.js';

const VOICE_PROVIDERS = ['elevenlabs'] as const;
type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export interface VoiceConfig {
  provider: VoiceProvider;
  apiKey: string;
  voiceId: string;
  model: string;
  language: string;
  enabled: boolean;
}

const DEFAULT_LANGUAGE = 'en';
const AUTO_LANGUAGE = 'auto';
const LANGUAGE_RE = /^(?:[a-z]{2,3}|auto)$/;

const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
const DEFAULT_VOICE_MODEL = 'anthropic:claude-sonnet-5-5';

const VOICE_FILE = 'voice.json';
const MAX_FIELD = 512;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isProvider = (value: unknown): value is VoiceProvider =>
  typeof value === 'string' && (VOICE_PROVIDERS as readonly string[]).includes(value);

export function parseVoice(raw: unknown): VoiceConfig {
  const r = isRecord(raw) ? raw : {};
  return {
    provider: isProvider(r.provider) ? r.provider : 'elevenlabs',
    apiKey: text(r.apiKey),
    voiceId: text(r.voiceId),
    model: text(r.model),
    language: LANGUAGE_RE.test(text(r.language)) ? text(r.language) : '',
    enabled: r.enabled !== false,
  };
}

export const readVoice = (dir = agentsDir()): VoiceConfig =>
  parseVoice(readJson<unknown>(join(dir, VOICE_FILE), null, { warn: 'voice: voice.json is not readable' }));

export function writeVoice(cfg: VoiceConfig, dir = agentsDir()): void {
  writeSecure(join(dir, VOICE_FILE), JSON.stringify(cfg, null, 2));
}

export const voiceIdOf = (cfg: VoiceConfig): string => (cfg.voiceId === '' ? DEFAULT_VOICE_ID : cfg.voiceId);
const voiceModelOf = (cfg: VoiceConfig): string => (cfg.model === '' ? DEFAULT_VOICE_MODEL : cfg.model);
export function brainModel(cfg: VoiceConfig, models: ModelConfig = readModelConfig()): string {
  const model = voiceModelOf(cfg);
  const anthropic = /^anthropic:(.+)$/.exec(model)?.[1];
  if (anthropic === undefined) return model;
  return models.connections.some((c) => c.provider === 'anthropic') ? model : anthropic;
}

export function languageOf(cfg: VoiceConfig): string | null {
  const language = cfg.language === '' ? DEFAULT_LANGUAGE : cfg.language;
  return language === AUTO_LANGUAGE ? null : language;
}

export const voiceReady = (cfg: VoiceConfig): boolean => cfg.enabled && cfg.apiKey !== '';

export function publicVoice(cfg: VoiceConfig): Record<string, unknown> {
  return {
    provider: cfg.provider,
    providers: VOICE_PROVIDERS,
    hasKey: cfg.apiKey !== '',
    voiceId: cfg.voiceId,
    model: cfg.model,
    language: cfg.language,
    enabled: cfg.enabled,
    defaults: { voiceId: DEFAULT_VOICE_ID, model: DEFAULT_VOICE_MODEL, language: DEFAULT_LANGUAGE },
  };
}

function field(body: Record<string, unknown>, key: string, current: string): string {
  const value = body[key];
  if (value === undefined) return current;
  if (typeof value !== 'string') throw new ApiError(`${key} must be a string`, 400);
  if (value.length > MAX_FIELD) throw new ApiError(`${key} is too long`, 400);
  return value.trim();
}

function keyOf(body: Record<string, unknown>, current: string): string {
  if (body.apiKey === null) return '';
  const next = field(body, 'apiKey', current);
  return next === '' ? current : next;
}

function languageField(body: Record<string, unknown>, current: string): string {
  const next = field(body, 'language', current).toLowerCase();
  if (next !== '' && !LANGUAGE_RE.test(next)) throw new ApiError("language is a two or three letter ISO 639 code, or 'auto'", 400);
  return next;
}

export function patchVoice(cfg: VoiceConfig, body: unknown): VoiceConfig {
  if (!isRecord(body)) throw new ApiError('the body must be a JSON object', 400);
  if (body.provider !== undefined && !isProvider(body.provider))
    throw new ApiError(`provider must be one of ${VOICE_PROVIDERS.join(', ')}`, 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new ApiError('enabled must be true or false', 400);
  return {
    provider: isProvider(body.provider) ? body.provider : cfg.provider,
    apiKey: keyOf(body, cfg.apiKey),
    voiceId: field(body, 'voiceId', cfg.voiceId),
    model: field(body, 'model', cfg.model),
    language: languageField(body, cfg.language),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : cfg.enabled,
  };
}
