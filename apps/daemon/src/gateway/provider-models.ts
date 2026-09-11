import { isRecord } from '@metro-labs/core/is-record';
import { GatewayError } from './forward.js';
import type { AnthropicSettings, BedrockSettings } from './model-config.js';

export const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const LIST_MAX = 1000;

export interface ProviderModel {
  id: string;
  name: string;
}

export const KNOWN_CLAUDE: ProviderModel[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function anthropicModels(settings: AnthropicSettings, base = ANTHROPIC_API, fetchImpl: typeof fetch = fetch): Promise<ProviderModel[]> {
  if (settings.apiKey === '') return KNOWN_CLAUDE;
  const res = await fetchImpl(`${base}/v1/models?limit=${String(LIST_MAX)}`, {
    headers: { 'x-api-key': settings.apiKey, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' },
    redirect: 'manual',
  });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `Anthropic would not list its models with the stored key (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (data === null) throw new GatewayError(502, 'api_error', 'Anthropic answered with no model list');
  return data
    .flatMap((entry) => (isRecord(entry) && str(entry.id) !== '' ? [{ id: str(entry.id), name: str(entry.display_name) || str(entry.id) }] : []))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const bedrockControlBase = (region: string): string => `https://bedrock.${region}.amazonaws.com`;

export async function bedrockModels(settings: BedrockSettings, base?: string, fetchImpl: typeof fetch = fetch): Promise<ProviderModel[]> {
  if (settings.region === '') throw new GatewayError(400, 'invalid_request_error', 'Bedrock needs a region before its models can be listed');
  if (settings.apiKey === '') throw new GatewayError(400, 'invalid_request_error', 'Bedrock needs an API key before its models can be listed');
  const res = await fetchImpl(`${base ?? bedrockControlBase(settings.region)}/inference-profiles?maxResults=${String(LIST_MAX)}`, {
    headers: { authorization: `Bearer ${settings.apiKey}`, accept: 'application/json' },
    redirect: 'manual',
  });
  if (!res.ok)
    throw new GatewayError(
      res.status,
      'api_error',
      `Bedrock would not list its inference profiles (${String(res.status)}); the stored key may cover the runtime only, so type the model id instead`,
    );
  const body: unknown = await res.json();
  const list = isRecord(body) && Array.isArray(body.inferenceProfileSummaries) ? body.inferenceProfileSummaries : null;
  if (list === null) throw new GatewayError(502, 'api_error', 'Bedrock answered with no inference profile list');
  return list
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = str(entry.inferenceProfileId);
      const status = str(entry.status);
      if (id === '' || !id.includes('anthropic') || (status !== '' && status !== 'ACTIVE')) return [];
      return [{ id, name: str(entry.inferenceProfileName) || id }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
