import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';
import { OPENAI_API } from '@metro-labs/connectors/codex-tokens';
import type { CodexSecret } from '@metro-labs/connectors/model-secret';
import { codexVersion } from './codex-version.js';
import type { ListedModel } from './list-cache.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const CODEX_BACKEND = 'https://chatgpt.com/backend-api/codex';
const LIST_MAX = 1000;
const OPENROUTER_MAX = 2000;
const LIST_TIMEOUT_MS = 10_000;
const OS_NAMES: Record<string, string> = { darwin: 'Mac OS', linux: 'Linux', win32: 'Windows' };

export const KNOWN_CLAUDE: ListedModel[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

interface Dated extends ListedModel {
  created: string;
}

const newestFirst = (list: Dated[]): ListedModel[] => list.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id)).map(({ id, name }) => ({ id, name }));

function refusal(provider: string, status: number, what: string): ApiError {
  if (status === 401 || status === 403) return new ApiError(`${provider} refused the stored credential (${String(status)}) ${what}`, 400);
  return new ApiError(`${provider} would not list its models (${String(status)})`, 503);
}

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, provider: string, what = ''): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel();
    throw refusal(provider, res.status, what);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) throw new ApiError(`${provider} answered with no model list`, 503);
  return body;
}

function claudeEntry(entry: unknown): Dated[] {
  if (!isRecord(entry) || stringOf(entry.id) === '') return [];
  const type = stringOf(entry.type);
  if (type !== '' && type !== 'model') return [];
  const id = stringOf(entry.id);
  return [{ id, name: stringOf(entry.display_name) || id, created: stringOf(entry.created_at) }];
}

export async function anthropicModels(apiKey: string, fetchImpl: FetchLike): Promise<ListedModel[]> {
  const body = await getJson(fetchImpl, `${ANTHROPIC_API}/v1/models?limit=${String(LIST_MAX)}`, { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }, 'Anthropic');
  if (!Array.isArray(body.data)) throw new ApiError('Anthropic answered with no model list', 503);
  return newestFirst(body.data.flatMap(claudeEntry));
}

function bedrockEntry(entry: unknown): Dated[] {
  if (!isRecord(entry)) return [];
  const id = stringOf(entry.inferenceProfileId);
  const status = stringOf(entry.status);
  if (id === '' || !id.includes('anthropic') || (status !== '' && status !== 'ACTIVE')) return [];
  return [{ id, name: stringOf(entry.inferenceProfileName) || id, created: stringOf(entry.createdAt) }];
}

export async function bedrockModels(apiKey: string, region: string, fetchImpl: FetchLike): Promise<ListedModel[]> {
  const url = `https://bedrock.${region}.amazonaws.com/inference-profiles?maxResults=${String(LIST_MAX)}`;
  const body = await getJson(fetchImpl, url, { authorization: `Bearer ${apiKey}` }, 'Bedrock', '; the stored key may cover the runtime only, so type the model id instead');
  if (!Array.isArray(body.inferenceProfileSummaries)) throw new ApiError('Bedrock answered with no inference profile list', 503);
  return newestFirst(body.inferenceProfileSummaries.flatMap(bedrockEntry));
}

function price(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null);

function chatCapable(entry: Record<string, unknown>): boolean {
  const output = strings(isRecord(entry.architecture) ? entry.architecture.output_modalities : undefined);
  const params = strings(entry.supported_parameters);
  return (output === null || output.includes('text')) && (params === null || params.includes('tools'));
}

function openrouterEntry(entry: unknown, zdr: Set<string>): { model: ListedModel; created: number }[] {
  if (!isRecord(entry) || !chatCapable(entry) || stringOf(entry.id) === '') return [];
  const id = stringOf(entry.id);
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const created = typeof entry.created === 'number' && Number.isFinite(entry.created) ? entry.created : 0;
  return [{ model: { id, name: stringOf(entry.name) || id, price: { prompt: price(pricing.prompt), completion: price(pricing.completion) }, zdr: zdr.has(id) }, created }];
}

async function zdrModels(fetchImpl: FetchLike): Promise<Set<string>> {
  const body = await getJson(fetchImpl, `${OPENROUTER_API}/endpoints/zdr`, {}, 'OpenRouter');
  const data: unknown[] = Array.isArray(body.data) ? body.data : [];
  return new Set(data.flatMap((entry) => (isRecord(entry) && stringOf(entry.model_id) !== '' ? [stringOf(entry.model_id)] : [])));
}

export async function openrouterModels(fetchImpl: FetchLike): Promise<ListedModel[]> {
  const [body, zdr] = await Promise.all([getJson(fetchImpl, `${OPENROUTER_API}/models`, {}, 'OpenRouter'), zdrModels(fetchImpl)]);
  if (!Array.isArray(body.data)) throw new ApiError('OpenRouter answered with no model list', 503);
  return body.data
    .flatMap((entry: unknown) => openrouterEntry(entry, zdr))
    .sort((a, b) => b.created - a.created || a.model.id.localeCompare(b.model.id))
    .slice(0, OPENROUTER_MAX)
    .map((entry) => entry.model);
}

const userAgent = (): string => `codex_cli_rs/${codexVersion()} (${OS_NAMES[platform()] ?? platform()} ${release()}; ${arch()}) metro`;

function codexHeaders(secret: CodexSecret): Record<string, string> {
  const plain = { authorization: `Bearer ${secret.accessToken}` };
  if (secret.method === 'chatgpt') return plain;
  return { ...plain, 'chatgpt-account-id': secret.accountId ?? '', originator: 'codex_cli_rs', 'user-agent': userAgent(), 'openai-beta': 'responses=experimental', 'session-id': randomUUID() };
}

export async function codexModels(secret: CodexSecret, version: string, fetchImpl: FetchLike): Promise<ListedModel[]> {
  const url = secret.method === 'chatgpt' ? `${OPENAI_API}/models` : `${CODEX_BACKEND}/models?client_version=${version}`;
  const body = await getJson(fetchImpl, url, codexHeaders(secret), 'OpenAI', 'for this ChatGPT plan');
  const models: unknown[] = Array.isArray(body.models) ? body.models : [];
  return models.filter(isRecord).flatMap((m) => ((m.visibility ?? 'list') === 'list' && stringOf(m.slug) !== '' ? [{ id: stringOf(m.slug), name: stringOf(m.slug) }] : []));
}
