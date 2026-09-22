import { matchModels, PROVIDERS, type ConnectionRow, type ModelOption, type ModelSettings, type Provider } from './model.js';

export const CONNECTIONS_SINCE = '0.1.0-beta.165';

export const providerLabel = (p: Provider): string => PROVIDERS.find((x) => x.id === p)?.label ?? p;

export const DEFAULT_MODEL = 'The model Claude Code asks for';

export const routedConnection = (s: ModelSettings): ConnectionRow | undefined => s.connections.find((c) => c.id === s.route);

const KEY_PROVIDERS: Provider[] = ['anthropic', 'bedrock', 'openrouter'];

export const usesKey = (p: Provider): boolean => KEY_PROVIDERS.includes(p);

const signedAs = (c: ConnectionRow): string => [c.account ?? 'signed in', c.plan === null ? '' : `(${c.plan})`].filter((x) => x !== '').join(' ');

export function connectionDetail(c: ConnectionRow): string {
  if (c.provider === 'bedrock') return [c.hasKey ? 'API key stored' : 'no key', c.region === '' ? 'no region' : c.region].join(' · ');
  if (c.provider === 'openrouter') return [c.hasKey ? 'API key stored' : 'no key', c.zdr ? 'zero data retention' : ''].filter((x) => x !== '').join(' · ');
  if (c.provider === 'anthropic') return c.hasKey ? 'API key stored' : 'your Claude Code login';
  return signedAs(c);
}

export const modelLabel = (c: ConnectionRow | undefined): string => (c === undefined ? DEFAULT_MODEL : c.model === '' ? DEFAULT_MODEL : c.model);

export interface PickRow extends ModelOption {
  connection: string;
  provider: Provider;
  label: string;
  current: boolean;
}

export interface PickInput {
  models: Record<string, ModelOption[]>;
  connections: ConnectionRow[];
  chip: string;
  query: string;
  route: string;
  zdr: Set<string> | null;
}

const PASSTHROUGH: Provider[] = ['anthropic', 'bedrock'];
const PASSTHROUGH_ROW: ModelOption = { id: '', name: DEFAULT_MODEL };

function rowsFor(input: PickInput, c: ConnectionRow): ModelOption[] {
  const listed = input.models[c.id] ?? [];
  const filtered = c.provider === 'openrouter' && c.zdr && input.zdr !== null ? listed.filter((m) => input.zdr?.has(m.id) === true) : listed;
  const withDefault = PASSTHROUGH.includes(c.provider) && input.query === '' ? [PASSTHROUGH_ROW, ...filtered] : filtered;
  return input.query === '' ? withDefault : matchModels(withDefault, input.query);
}

export function pickRows(input: PickInput): PickRow[] {
  const shown = input.chip === 'all' ? input.connections : input.connections.filter((c) => c.id === input.chip);
  return shown.flatMap((c) =>
    rowsFor(input, c).map((m) => ({ ...m, connection: c.id, provider: c.provider, label: c.label, current: c.id === input.route && m.id === c.model })),
  );
}

export const typedRow = (input: PickInput): PickRow | null => {
  const typed = input.query.trim();
  const chosen = input.connections.find((c) => c.id === input.chip);
  if (chosen === undefined || typed === '' || pickRows(input).some((r) => r.id === typed)) return null;
  return { id: typed, name: typed, connection: chosen.id, provider: chosen.provider, label: chosen.label, current: false };
};
