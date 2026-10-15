import { PROVIDERS, usageOf, usesKey, type ConnectionRow, type ModelSettings, type Provider, type ProviderInfo } from './model.js';
import { matchModels, type ModelOption } from './model-options.js';
import { LOCAL_SESSION, isLocal } from './model-route.js';

export const providerInfo = (p: Provider | undefined): ProviderInfo | undefined => PROVIDERS.find((x) => x.id === p);

export const providerLabel = (p: Provider): string => providerInfo(p)?.label ?? p;

export const DEFAULT_MODEL = 'The model Claude Code asks for';

export const routedConnection = (s: ModelSettings): ConnectionRow | undefined => {
  const id = s.route?.primary.connection ?? LOCAL_SESSION;
  return s.connections.find((c) => c.id === id);
};

export const routedUsage = (s: ModelSettings): ModelSettings['usage'][string] | undefined => usageOf(s, s.route?.primary.connection ?? LOCAL_SESSION);

export const usesSessionLogin = (c: ConnectionRow): boolean =>
  c.id === LOCAL_SESSION || (c.provider === 'anthropic' && !c.hasKey && c.account === null && !isLocal(c.id));

const signedAs = (c: ConnectionRow): string => [c.account ?? 'signed in', c.plan === null ? '' : `(${c.plan})`].filter((x) => x !== '').join(' ');

export function connectionDetail(c: ConnectionRow): string {
  if (c.signedOut) return usesKey(c.provider) ? 'no key yet, add one' : 'signed out, sign in again';
  if (c.provider === 'bedrock') return ['API key stored', c.region === '' ? 'no region' : c.region].join(' · ');
  if (c.provider === 'openrouter') return ['API key stored', c.zdr ? 'zero data retention' : ''].filter((x) => x !== '').join(' · ');
  if (usesSessionLogin(c)) return 'the login Claude Code is signed in with';
  if (c.provider === 'anthropic' && c.hasKey) return 'API key stored';
  return signedAs(c);
}

export interface PickRow extends ModelOption {
  connection: string;
  provider: Provider;
  label: string;
  current: boolean;
}

export interface PickInput {
  models: ModelOption[];
  connection: ConnectionRow;
  query: string;
  current: string;
  named: boolean;
}

const DEFAULT_ROW: ModelOption = { id: '', name: DEFAULT_MODEL, price: '', zdr: null };

const rowOf = (input: PickInput, model: ModelOption): PickRow => ({
  ...model,
  connection: input.connection.id,
  provider: input.connection.provider,
  label: input.connection.label,
  current: model.id === input.current,
});

const zdrOnly = (c: ConnectionRow): boolean => c.provider === 'openrouter' && c.zdr;

export function pickRows(input: PickInput): PickRow[] {
  const blank = !input.named && isLocal(input.connection.id) && input.query === '';
  const models = zdrOnly(input.connection) ? input.models.filter((m) => m.zdr !== false) : input.models;
  const listed = blank ? [DEFAULT_ROW, ...models] : models;
  const shown = input.query === '' ? listed : matchModels(listed, input.query);
  return shown.map((model) => rowOf(input, model));
}

export function typedRow(input: PickInput): PickRow | null {
  const typed = input.query.trim();
  if (typed === '' || pickRows(input).some((r) => r.id === typed)) return null;
  return { ...rowOf(input, { id: typed, name: typed, price: '', zdr: null }), current: false };
}
