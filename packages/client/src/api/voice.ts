import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord } from '../read.js';

export const VOICE_SINCE = '0.1.0-beta.237';
export const ELEVENLABS_KEYS_URL = 'https://elevenlabs.io/app/settings/api-keys';
export const ELEVENLABS_VOICES_URL = 'https://elevenlabs.io/app/voice-library';

export interface VoiceSettings {
  provider: string;
  providers: string[];
  hasKey: boolean;
  voiceId: string;
  model: string;
  language: string | null;
  enabled: boolean;
  defaults: { voiceId: string; model: string; language: string };
}

export interface VoicePatch {
  apiKey?: string;
  voiceId?: string;
  model?: string;
  language?: string;
  enabled?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toVoice(body: unknown): VoiceSettings {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const defaults = isRecord(body.defaults) ? body.defaults : {};
  return {
    provider: str(body.provider),
    providers: Array.isArray(body.providers) ? body.providers.filter((p): p is string => typeof p === 'string') : [],
    hasKey: body.hasKey === true,
    voiceId: str(body.voiceId),
    model: str(body.model),
    language: typeof body.language === 'string' ? body.language : null,
    enabled: body.enabled !== false,
    defaults: { voiceId: str(defaults.voiceId), model: str(defaults.model), language: str(defaults.language) },
  };
}

const BASE = (): string => `${daemonBase()}/api/voice`;

export const fetchVoice = async (): Promise<VoiceSettings> => toVoice(await call({ method: 'GET', base: BASE() }));

export async function saveVoice(patch: VoicePatch): Promise<VoiceSettings> {
  return toVoice(await call({ method: 'PUT', base: BASE(), headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
}

export const providerName = (id: string): string => (id === 'elevenlabs' ? 'ElevenLabs' : id);

export const voiceModelLabel = (model: string): string => model.replace(/^anthropic:/, '');

export const VOICE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'auto', label: 'Detect' },
];
