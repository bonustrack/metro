import { call } from './client';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/daemon';

export type Provider = 'anthropic' | 'bedrock' | 'openrouter' | 'codex';

export interface ProviderInfo {
  id: Provider;
  label: string;
  blurb: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    blurb:
      'Claude models. With no key here, the request carries the login of the Claude Code session that sent it, untouched. Add a key and metro bills that key instead, and can pin the model.',
  },
  { id: 'bedrock', label: 'Amazon Bedrock', blurb: 'Claude models billed to your AWS account, through a Bedrock API key.' },
  { id: 'openrouter', label: 'OpenRouter', blurb: 'Any model OpenRouter serves, Claude, GPT and Codex, Gemini, through one OpenRouter key.' },
  {
    id: 'codex',
    label: 'Codex (ChatGPT)',
    blurb: 'GPT and Codex models on your ChatGPT subscription, signed in with your ChatGPT account. Unofficial: metro speaks the Codex CLI protocol, and OpenAI can change it at any time.',
  },
];

export interface Served {
  provider: string;
  model: string;
  at: string;
}

export interface ModelSettings {
  provider: Provider;
  ready: boolean;
  reason: string | null;
  lastServed: Served | null;
  anthropic: { model: string; hasKey: boolean };
  bedrock: { region: string; model: string; hasKey: boolean };
  openrouter: { model: string; hasKey: boolean };
  codex: { model: string; signedIn: boolean; account: string | null; plan: string | null };
}

export interface ModelPatch {
  provider?: Provider;
  anthropic?: { apiKey?: string; model?: string };
  bedrock?: { region?: string; apiKey?: string; model?: string };
  openrouter?: { apiKey?: string; model?: string };
  codex?: { model?: string };
}

const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const word = (value: unknown): string => (typeof value === 'string' ? value : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const isProvider = (value: unknown): value is Provider => PROVIDERS.some((p) => p.id === value);

export function toServed(value: unknown): Served | null {
  if (!isRecord(value)) return null;
  const provider = word(value.provider);
  const model = word(value.model);
  const at = word(value.at);
  return provider === '' || model === '' || at === '' ? null : { provider, model, at };
}

export function toModelSettings(body: unknown): ModelSettings {
  if (!isRecord(body) || !isProvider(body.provider)) throw unexpected();
  const anthropic = isRecord(body.anthropic) ? body.anthropic : {};
  const bedrock = isRecord(body.bedrock) ? body.bedrock : {};
  const openrouter = isRecord(body.openrouter) ? body.openrouter : {};
  const codex = isRecord(body.codex) ? body.codex : {};
  return {
    provider: body.provider,
    ready: body.ready === true,
    reason: maybe(body.reason),
    lastServed: toServed(body.lastServed),
    anthropic: { model: word(anthropic.model), hasKey: anthropic.hasKey === true },
    bedrock: { region: word(bedrock.region), model: word(bedrock.model), hasKey: bedrock.hasKey === true },
    openrouter: { model: word(openrouter.model), hasKey: openrouter.hasKey === true },
    codex: { model: word(codex.model), signedIn: codex.signedIn === true, account: maybe(codex.account), plan: maybe(codex.plan) },
  };
}

const modelUrl = (): string => `${daemonBase()}/api/model`;
const json = { 'content-type': 'application/json' };

export async function fetchModel(): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'GET', base: modelUrl() }));
}

export async function saveModel(patch: ModelPatch): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'PUT', base: modelUrl(), headers: json, body: JSON.stringify(patch) }));
}

export async function beginCodexLogin(): Promise<string> {
  const body = await call({ method: 'POST', base: modelUrl(), path: '/codex/login' });
  if (!isRecord(body) || typeof body.url !== 'string') throw unexpected();
  return body.url;
}

export async function finishCodexLogin(url: string): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: '/codex/callback', headers: json, body: JSON.stringify({ url }) }));
}

export async function codexLogout(): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: '/codex/logout' }));
}

export async function codexImport(): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: '/codex/import' }));
}

export async function codexModels(): Promise<string[]> {
  const body = await call({ method: 'GET', base: modelUrl(), path: '/codex/models' });
  if (!isRecord(body) || !Array.isArray(body.models)) throw unexpected();
  return body.models.filter((m): m is string => typeof m === 'string');
}

export const servedLabel = (served: Served): string => (served.provider === 'anthropic' ? served.model : `${served.provider}:${served.model}`);

export function routeLabel(settings: ModelSettings): string {
  if (settings.provider === 'bedrock') return `Amazon Bedrock · ${settings.bedrock.model === '' ? 'the model Claude Code asks for' : settings.bedrock.model}`;
  if (settings.provider === 'openrouter') return `OpenRouter · ${settings.openrouter.model === '' ? 'no model chosen' : settings.openrouter.model}`;
  if (settings.provider === 'codex') return `Codex · ${settings.codex.model === '' ? 'no model chosen' : settings.codex.model}`;
  const how = settings.anthropic.hasKey ? 'the key on this page' : 'your Claude Code login';
  return `Anthropic · ${settings.anthropic.model === '' ? 'the model Claude Code asks for' : settings.anthropic.model} · ${how}`;
}

export interface Draft {
  provider: Provider;
  anthropicModel: string;
  anthropicKey: string;
  anthropicForget: boolean;
  bedrockRegion: string;
  bedrockModel: string;
  bedrockKey: string;
  bedrockForget: boolean;
  openrouterModel: string;
  openrouterKey: string;
  openrouterForget: boolean;
  codexModel: string;
}

export const draftOf = (s: ModelSettings): Draft => ({
  provider: s.provider,
  anthropicModel: s.anthropic.model,
  anthropicKey: '',
  anthropicForget: false,
  bedrockRegion: s.bedrock.region,
  bedrockModel: s.bedrock.model,
  bedrockKey: '',
  bedrockForget: false,
  openrouterModel: s.openrouter.model,
  openrouterKey: '',
  openrouterForget: false,
  codexModel: s.codex.model,
});

const keyPatch = (typed: string, forget: boolean): { apiKey?: string } => (forget ? { apiKey: '' } : typed === '' ? {} : { apiKey: typed });

export function patchOf(draft: Draft): ModelPatch {
  return {
    provider: draft.provider,
    anthropic: { model: draft.anthropicModel, ...keyPatch(draft.anthropicKey, draft.anthropicForget) },
    bedrock: { region: draft.bedrockRegion, model: draft.bedrockModel, ...keyPatch(draft.bedrockKey, draft.bedrockForget) },
    openrouter: { model: draft.openrouterModel, ...keyPatch(draft.openrouterKey, draft.openrouterForget) },
    codex: { model: draft.codexModel },
  };
}

export const afterSave = (draft: Draft): Draft => ({
  ...draft,
  anthropicKey: '',
  anthropicForget: false,
  bedrockKey: '',
  bedrockForget: false,
  openrouterKey: '',
  openrouterForget: false,
});

export interface DeviceLogin {
  id: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
}

export type DevicePoll = { status: 'pending' } | { status: 'done' } | { status: 'failed'; error: string };

export async function beginCodexDevice(): Promise<DeviceLogin> {
  const body = await call({ method: 'POST', base: modelUrl(), path: '/codex/device' });
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.user_code !== 'string' || typeof body.verify_url !== 'string') throw unexpected();
  return { id: body.id, userCode: body.user_code, verifyUrl: body.verify_url, interval: typeof body.interval === 'number' && body.interval >= 1 ? body.interval : 5 };
}

export async function pollCodexDevice(id: string): Promise<DevicePoll> {
  const body = await call({ method: 'GET', base: modelUrl(), path: `/codex/device/${id}` });
  if (!isRecord(body)) throw unexpected();
  if (body.status === 'done') return { status: 'done' };
  if (body.status === 'failed') return { status: 'failed', error: typeof body.error === 'string' ? body.error : 'The sign-in did not finish.' };
  return { status: 'pending' };
}

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';
export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
const MATCH_MAX = 40;

export interface ModelOption {
  id: string;
  name: string;
  prompt?: number | null;
  completion?: number | null;
}

const PER_MILLION = 1_000_000;

const amount = (perToken: number): string => {
  const each = perToken * PER_MILLION;
  return `$${String(Number(each.toFixed(each >= 1 ? 2 : 3)))}`;
};

export function priceLabel(model: ModelOption): string {
  const { prompt, completion } = model;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return '';
  if (prompt === 0 && completion === 0) return 'Free';
  return `${amount(prompt)} in · ${amount(completion)} out per 1M`;
}

export async function openrouterModels(): Promise<ModelOption[]> {
  const body = await call({ method: 'GET', base: modelUrl(), path: '/openrouter/models' });
  if (!isRecord(body) || !Array.isArray(body.models)) throw unexpected();
  return body.models.flatMap((m: unknown) =>
    isRecord(m) && typeof m.id === 'string'
      ? [
          {
            id: m.id,
            name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
            prompt: typeof m.prompt === 'number' ? m.prompt : null,
            completion: typeof m.completion === 'number' ? m.completion : null,
          },
        ]
      : [],
  );
}

export function matchModels(models: ModelOption[], query: string, limit = MATCH_MAX): ModelOption[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  const hit = (model: ModelOption): boolean => {
    const hay = `${model.id} ${model.name}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  };
  return models.filter(hit).slice(0, limit);
}
