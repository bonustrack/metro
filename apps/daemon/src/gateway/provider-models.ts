import type { IncomingHttpHeaders } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { GatewayError, OAUTH_BETA } from './forward.js';
import { listCache } from './model-lists.js';
import { stringOf } from '@metro-labs/http/api-http';

export const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const LIST_MAX = 1000;
const LIST_TIMEOUT_MS = 10_000;
const BEARER = 'Bearer ';

export interface ProviderModel {
  id: string;
  name: string;
}

interface Dated extends ProviderModel {
  created: string;
}

const KNOWN_CLAUDE: ProviderModel[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

const claudeLists = listCache<ProviderModel>('anthropic');

const newestFirst = (list: Dated[]): ProviderModel[] =>
  list.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id)).map(({ id, name }) => ({ id, name }));

function claudeEntry(entry: unknown): Dated[] {
  if (!isRecord(entry) || stringOf(entry.id) === '') return [];
  const type = stringOf(entry.type);
  if (type !== '' && type !== 'model') return [];
  const id = stringOf(entry.id);
  return [{ id, name: stringOf(entry.display_name) || id, created: stringOf(entry.created_at) }];
}

async function listClaude(auth: Record<string, string>, what: string, base: string, fetchImpl: typeof fetch): Promise<ProviderModel[]> {
  const res = await fetchImpl(`${base}/v1/models?limit=${String(LIST_MAX)}`, {
    headers: { ...auth, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `Anthropic would not list its models with ${what} (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (data === null) throw new GatewayError(502, 'api_error', 'Anthropic answered with no model list');
  return newestFirst(data.flatMap(claudeEntry));
}

const loginKey = (base: string): string => `login:${base}`;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value)?.trim() ?? '';

function loginAuth(headers: IncomingHttpHeaders): Record<string, string> | null {
  const bearer = first(headers.authorization);
  if (bearer.startsWith(BEARER) && bearer.length > BEARER.length) return { authorization: bearer, 'anthropic-beta': OAUTH_BETA };
  const key = first(headers['x-api-key']);
  return key === '' ? null : { 'x-api-key': key };
}

export function refreshLoginModels(headers: IncomingHttpHeaders, base = ANTHROPIC_API, fetchImpl: typeof fetch = fetch): Promise<void> {
  const auth = loginAuth(headers);
  if (auth === null) return Promise.resolve();
  return claudeLists.refresh(loginKey(base), () => listClaude(auth, 'the Claude Code login', base, fetchImpl));
}

export function claudeModels(base = ANTHROPIC_API): ProviderModel[] {
  const live = claudeLists.peek(loginKey(base)) ?? [];
  return live.length > 0 ? live : KNOWN_CLAUDE;
}
