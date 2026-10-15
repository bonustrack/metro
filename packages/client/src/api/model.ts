import { filled, isRecord, str } from '../read.js';
import { call } from './client.js';
import { toUsage, untilLabel, type Usage } from './usage.js';
import { daemonBase } from '../auth/daemon.js';
import { toModelOptions, type ModelOption } from './model-options.js';
import { LOCAL_SESSION, isLocal, localLogin, toFallbacks, toSource, type ModelRoute, type RouteSource, type RouteStep } from './model-route.js';

export type Provider = 'anthropic' | 'bedrock' | 'openrouter' | 'codex';

export interface ProviderInfo {
  id: Provider;
  label: string;
  site: string;
  blurb: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', site: 'https://anthropic.com', blurb: 'Claude models, with an API key from the Anthropic Console.' },
  { id: 'bedrock', label: 'Amazon Bedrock', site: 'https://aws.amazon.com', blurb: 'Claude models billed to your AWS account.' },
  { id: 'openrouter', label: 'OpenRouter', site: 'https://openrouter.ai', blurb: 'Any model OpenRouter serves, through one key.' },
  { id: 'codex', label: 'Codex (ChatGPT)', site: 'https://openai.com', blurb: "GPT models on a ChatGPT Plus or Pro plan, with OpenAI's official sign-in." },
];

export type CodexMethod = 'chatgpt' | 'code';

export interface ConnectionRow {
  id: string;
  provider: Provider;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  hasKey: boolean;
  signedOut: boolean;
  account: string | null;
  plan: string | null;
  method: CodexMethod | null;
}

export interface ClaudeLoginRow {
  id: string;
  email: string | null;
  plan: string | null;
  savedAt: string;
}

export interface Served {
  connection: string;
  provider: string;
  model: string;
  at: string;
}

export interface Hold {
  reason: string;
  until: string | null;
}

export const holdLine = (hold: Hold): string => (hold.until === null ? hold.reason : `${hold.reason}, ${untilLabel(hold.until)}`);

export interface ChainRow extends RouteStep {
  used: number | null;
  hold: Hold | null;
  active: boolean;
}

export interface ModelSync {
  enrolled: boolean;
  at: string | null;
  error: string | null;
}

export interface ModelSettings {
  route: ModelRoute | null;
  source: RouteSource;
  sync: ModelSync | null;
  ready: boolean;
  reason: string | null;
  lastServed: Served | null;
  usage: Usage;
  connections: ConnectionRow[];
  claude: ClaudeLoginRow[];
  chain: ChainRow[];
}

const KEY_PROVIDERS: Provider[] = ['anthropic', 'bedrock', 'openrouter'];
export const SESSION_LABEL = 'Claude Code login of the server';
export const CLAUDE_LOGIN_LABEL = 'Claude subscription';

const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const isProvider = (value: unknown): value is Provider => PROVIDERS.some((p) => p.id === value);
const methodOf = (value: unknown): CodexMethod | null => (value === 'chatgpt' || value === 'code' ? value : null);

export const usesKey = (p: Provider): boolean => KEY_PROVIDERS.includes(p);

export function toServed(value: unknown): Served | null {
  if (!isRecord(value)) return null;
  const model = str(value.model);
  const at = str(value.at);
  return model === '' || at === '' ? null : { connection: str(value.connection), provider: str(value.provider), model, at };
}

function accountOf(raw: Record<string, unknown>): Pick<ConnectionRow, 'account' | 'plan' | 'method'> {
  if (isRecord(raw.account)) return { account: filled(raw.account.email), plan: filled(raw.account.plan), method: methodOf(raw.account.method) };
  return { account: filled(raw.account), plan: filled(raw.plan), method: methodOf(raw.method) };
}

export function toConnection(raw: unknown): ConnectionRow | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '' || !isProvider(raw.provider)) return null;
  const provider = raw.provider;
  return {
    id: raw.id,
    provider,
    label: str(raw.label),
    model: str(raw.model),
    region: str(raw.region),
    zdr: raw.zdr === true,
    hasKey: typeof raw.hasKey === 'boolean' ? raw.hasKey : usesKey(provider) && !isLocal(raw.id),
    signedOut: raw.signedOut === true,
    ...accountOf(raw),
  };
}

function toClaudeLogin(raw: unknown): ClaudeLoginRow | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
  return { id: raw.id, email: filled(raw.email), plan: filled(raw.plan), savedAt: str(raw.savedAt) };
}

const blank = (id: string, label: string): ConnectionRow => ({
  id, provider: 'anthropic', label, model: '', region: '', zdr: false, hasKey: false, signedOut: false, account: null, plan: null, method: null,
});

export function localConnections(claude: ClaudeLoginRow[]): ConnectionRow[] {
  return [blank(LOCAL_SESSION, SESSION_LABEL), ...claude.map((login) => ({ ...blank(localLogin(login.id), CLAUDE_LOGIN_LABEL), account: login.email, plan: login.plan }))];
}

function toHold(raw: unknown): Hold | null {
  if (!isRecord(raw) || typeof raw.reason !== 'string') return null;
  return { reason: raw.reason, until: filled(raw.until) };
}

function toChainRow(raw: unknown): ChainRow | null {
  if (!isRecord(raw)) return null;
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? Math.min(1, Math.max(0, raw.used)) : null;
  return { connection: str(raw.connection), model: str(raw.model), used, hold: toHold(raw.hold), active: raw.active === true };
}

function routeOf(body: Record<string, unknown>): ModelRoute | null {
  const id = str(body.route);
  const fallbacks = toFallbacks(body.fallbacks);
  if (id === '') return fallbacks.length === 0 ? null : { primary: { connection: LOCAL_SESSION, model: '' }, fallbacks };
  return { primary: { connection: id, model: str(body.model) }, fallbacks };
}

function toSync(raw: unknown): ModelSync | null {
  if (!isRecord(raw)) return null;
  return { enrolled: raw.enrolled === true, at: filled(raw.at), error: filled(raw.error) };
}

const listOf = <T>(raw: unknown, make: (item: unknown) => T | null): T[] => (Array.isArray(raw) ? raw.flatMap((item: unknown) => make(item) ?? []) : []);

export function toModelSettings(body: unknown): ModelSettings {
  if (!isRecord(body) || typeof body.route !== 'string' || !Array.isArray(body.connections)) throw unexpected();
  const claude = listOf(body.claude, toClaudeLogin);
  const listed = listOf(body.connections, toConnection);
  const connections = [...listed, ...localConnections(claude).filter((row) => !listed.some((c) => c.id === row.id))];
  return {
    route: routeOf(body),
    source: toSource(body.source),
    sync: toSync(body.sync),
    ready: body.ready === true,
    reason: filled(body.reason),
    lastServed: toServed(body.lastServed),
    usage: toUsage(body.usage),
    connections,
    claude,
    chain: listOf(body.chain, toChainRow),
  };
}

export const usageOf = (settings: ModelSettings, connection: string): Usage[string] | undefined => settings.usage[connection];

const modelUrl = (): string => `${daemonBase()}/api/model`;

export async function fetchModel(): Promise<ModelSettings> {
  return toModelSettings(await call({ method: 'GET', base: modelUrl() }));
}

export async function syncModel(): Promise<void> {
  await call({ method: 'POST', base: modelUrl(), path: '/sync' });
}

export async function removeClaudeLogin(id: string): Promise<void> {
  await call({ method: 'DELETE', base: modelUrl(), path: `/claude/${encodeURIComponent(id)}` });
}

export async function claudeModels(): Promise<ModelOption[]> {
  return toModelOptions(await call({ method: 'GET', base: modelUrl(), path: '/claude-models' }));
}

const CODE_PARAM = /(?:^|[?&])code=[^&\s]/;
const STATE_PARAM = /(?:^|[?&])state=[^&\s]/;

export const carriesCodeAndState = (pasted: string): boolean => CODE_PARAM.test(pasted.trim()) && STATE_PARAM.test(pasted.trim());

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
