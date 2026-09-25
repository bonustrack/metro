import { filled, isRecord, str } from './read.js';
import { call } from './client.js';
import { toUsage, type Usage } from './usage.js';
import { daemonBase } from '../auth/daemon.js';

export type Provider = 'anthropic' | 'bedrock' | 'openrouter' | 'codex' | 'gemini';

export interface ProviderInfo {
  id: Provider;
  label: string;
  site: string;
  blurb: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    site: 'https://anthropic.com',
    blurb: 'Claude models, on the session’s own Claude Code login or on an API key you add.',
  },
  { id: 'bedrock', label: 'Amazon Bedrock', site: 'https://aws.amazon.com', blurb: 'Claude models billed to your AWS account.' },
  { id: 'openrouter', label: 'OpenRouter', site: 'https://openrouter.ai', blurb: 'Any model OpenRouter serves, through one key.' },
  {
    id: 'codex',
    label: 'Codex (ChatGPT)',
    site: 'https://openai.com',
    blurb: 'GPT and Codex models on your ChatGPT subscription. Unofficial: OpenAI can cut it off at any time.',
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    site: 'https://gemini.google.com',
    blurb: 'Gemini models on your Google AI plan. Unofficial: Google can cut it off at any time.',
  },
];

export interface Served {
  connection: string;
  provider: string;
  model: string;
  at: string;
}

export interface ConnectionRow {
  id: string;
  provider: Provider;
  label: string;
  model: string;
  hasKey: boolean;
  region: string;
  zdr: boolean;
  signedIn: boolean;
  account: string | null;
  plan: string | null;
}

export interface ModelSettings {
  route: string;
  ready: boolean;
  reason: string | null;
  lastServed: Served | null;
  usage: Usage;
  connections: ConnectionRow[];
}

export interface ConnectionPatch {
  provider?: Provider;
  label?: string;
  model?: string;
  apiKey?: string;
  region?: string;
  zdr?: boolean;
}

const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const isProvider = (value: unknown): value is Provider => PROVIDERS.some((p) => p.id === value);

export function toServed(value: unknown): Served | null {
  if (!isRecord(value)) return null;
  const model = str(value.model);
  const at = str(value.at);
  return model === '' || at === '' ? null : { connection: str(value.connection), provider: str(value.provider), model, at };
}

function toConnection(raw: unknown): ConnectionRow | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isProvider(raw.provider)) return null;
  return {
    id: raw.id,
    provider: raw.provider,
    label: str(raw.label),
    model: str(raw.model),
    hasKey: raw.hasKey === true,
    region: str(raw.region),
    zdr: raw.zdr === true,
    signedIn: raw.signedIn === true,
    account: filled(raw.account),
    plan: filled(raw.plan),
  };
}

export function toModelSettings(body: unknown): ModelSettings {
  if (!isRecord(body) || !Array.isArray(body.connections)) throw unexpected();
  return {
    route: str(body.route),
    ready: body.ready === true,
    reason: filled(body.reason),
    lastServed: toServed(body.lastServed),
    usage: toUsage(body.usage),
    connections: body.connections.flatMap((c: unknown) => toConnection(c) ?? []),
  };
}

const modelUrl = (): string => `${daemonBase()}/api/model`;
const json = { 'content-type': 'application/json' };

export async function fetchModel(): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'GET', base: modelUrl() }));
}

export async function fetchModelBundle(): Promise<Record<string, unknown>> {
  const body = await call({ method: 'GET', base: `${modelUrl()}/bundle` });
  if (!isRecord(body)) throw unexpected();
  return body;
}

export async function restoreModelBundle(bundle: Record<string, unknown>): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: `${modelUrl()}/restore`, headers: json, body: JSON.stringify(bundle) }));
}

export async function chooseConnection(id: string): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'PUT', base: modelUrl(), headers: json, body: JSON.stringify({ route: id }) }));
}

export async function addConnection(patch: ConnectionPatch): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: '/connections', headers: json, body: JSON.stringify(patch) }));
}

export async function saveConnection(id: string, patch: ConnectionPatch): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'PUT', base: modelUrl(), path: `/connections/${id}`, headers: json, body: JSON.stringify(patch) }));
}

export async function dropConnection(id: string): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'DELETE', base: modelUrl(), path: `/connections/${id}` }));
}

const withConnection = (path: string, id: string): string => (id === '' ? path : `${path}?connection=${encodeURIComponent(id)}`);

export async function beginCodexLogin(): Promise<string> {
  const body = await call({ method: 'POST', base: modelUrl(), path: '/codex/login' });
  if (!isRecord(body) || typeof body.url !== 'string') throw unexpected();
  return body.url;
}

export async function finishCodexLogin(url: string, id = ''): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: withConnection('/codex/callback', id), headers: json, body: JSON.stringify({ url }) }));
}

export async function codexImport(id = ''): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: withConnection('/codex/import', id) }));
}

export async function beginGeminiLogin(): Promise<{ url: string; state: string }> {
  const body = await call({ method: 'POST', base: modelUrl(), path: '/gemini/login' });
  if (!isRecord(body) || typeof body.url !== 'string' || typeof body.state !== 'string') throw unexpected();
  return { url: body.url, state: body.state };
}

export async function finishGeminiLogin(code: string, state: string, project: string, id = ''): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'POST', base: modelUrl(), path: withConnection('/gemini/code', id), headers: json, body: JSON.stringify({ code, state, project }) }));
}

export async function geminiModels(id: string): Promise<string[]> {
  const body = await call({ method: 'GET', base: modelUrl(), path: withConnection('/gemini/models', id) });
  if (!isRecord(body) || !Array.isArray(body.models)) throw unexpected();
  return body.models.filter((m): m is string => typeof m === 'string');
}

export async function codexModels(id: string): Promise<string[]> {
  const body = await call({ method: 'GET', base: modelUrl(), path: withConnection('/codex/models', id) });
  if (!isRecord(body) || !Array.isArray(body.models)) throw unexpected();
  return body.models.filter((m): m is string => typeof m === 'string');
}

export const servedLabel = (served: Served): string => (served.provider === 'anthropic' ? served.model : `${served.provider}:${served.model}`);

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

export async function pollCodexDevice(id: string, connection = ''): Promise<DevicePoll> {
  const body = await call({ method: 'GET', base: modelUrl(), path: withConnection(`/codex/device/${id}`, connection) });
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
  created?: number | null;
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
            created: typeof m.created === 'number' ? m.created : null,
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

export async function openrouterZdrModels(): Promise<Set<string>> {
  const body = await call({ method: 'GET', base: modelUrl(), path: '/openrouter/zdr' });
  if (!isRecord(body) || !Array.isArray(body.models)) throw unexpected();
  return new Set(body.models.filter((id): id is string => typeof id === 'string'));
}

async function providerModels(path: string, id: string): Promise<ModelOption[]> {
  const body = await call({ method: 'GET', base: modelUrl(), path: id === '' ? path : `${path}?connection=${encodeURIComponent(id)}` });
  if (!isRecord(body) || !Array.isArray(body.models)) throw unexpected();
  return body.models.flatMap((m: unknown) =>
    isRecord(m) && typeof m.id === 'string' ? [{ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id }] : [],
  );
}

export const anthropicModels = (id: string): Promise<ModelOption[]> => providerModels('/anthropic/models', id);
export const bedrockModels = (id: string): Promise<ModelOption[]> => providerModels('/bedrock/models', id);
